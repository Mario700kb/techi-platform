"""Phase 4 — Enterprise Credential Vault tests (extended 2026-07-10 into a
full enterprise secret manager: types/purpose/scope/assignments/lifecycle/
test-connection/granular RBAC).

Locks: AES-256-GCM envelope round-trip + tamper detection, scope integrity,
usage audit on every access, reveal semantics, the flag-off invisibility
contract (404 on every route when FEATURE_VAULT is off), the credential-type
registry, scope-resolution precedence, assignments, and RBAC.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker
from types import SimpleNamespace

import app.core.vault_cipher as vault_cipher
from app.api.v1.endpoints import vault as vault_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.operator import Operator, OperatorRole
from app.models.team import Team, TeamMember
from app.models.vault_credential import VaultCredential, VaultCredentialAssignment, VaultCredentialUsage
from app.platform_core.vault_credential_types import (
    VAULT_CREDENTIAL_TYPES,
    VaultCredentialTypeError,
    validate_metadata,
    validate_secret_fields,
)
from app.schemas.vault import VaultCredentialCreate, VaultCredentialUpdate
from app.services.vault_service import VaultReferencedError, VaultScopeError, VaultService


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _session():
    from sqlalchemy.pool import StaticPool

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    # SQLite ignores foreign keys unless told otherwise — production Postgres
    # enforces them. Without this pragma, a test suite would happily pass a
    # delete that violates a real FK in prod (exactly what happened here: see
    # CHANGELOG-SOLUTIONS 2026-07-10, vault_credential_usage_credential_id_fkey).
    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_connection, _):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(
        bind=engine,
        tables=[
            VaultCredential.__table__,
            VaultCredentialUsage.__table__,
            VaultCredentialAssignment.__table__,
            AuditLog.__table__,
            Client.__table__,
            DeviceGroup.__table__,
            Device.__table__,
            Team.__table__,
            TeamMember.__table__,
        ],
    )
    return sessionmaker(bind=engine)()


def _create_payload(**overrides):
    data = dict(name="test-cred", credential_type="password", secret="s3cr3t!")
    data.update(overrides)
    return VaultCredentialCreate(**data)


class TestVaultCipher:
    def test_round_trip(self):
        ciphertext, wrapped = vault_cipher.encrypt_secret("hello ë ç 秘密")
        assert "hello" not in ciphertext
        assert vault_cipher.decrypt_secret(ciphertext, wrapped) == "hello ë ç 秘密"

    def test_unique_dek_per_secret(self):
        c1, w1 = vault_cipher.encrypt_secret("same")
        c2, w2 = vault_cipher.encrypt_secret("same")
        assert c1 != c2 and w1 != w2

    def test_tamper_detection(self):
        ciphertext, wrapped = vault_cipher.encrypt_secret("secret")
        tampered = ciphertext[:-5] + ("AAAAA" if not ciphertext.endswith("AAAAA") else "BBBBB")
        with pytest.raises(vault_cipher.VaultCipherError):
            vault_cipher.decrypt_secret(tampered, wrapped)

    def test_master_key_file_created_with_restrictive_mode(self, tmp_path):
        import os

        vault_cipher.encrypt_secret("x")
        path = settings.VAULT_MASTER_KEY_FILE
        assert os.path.exists(path)
        assert oct(os.stat(path).st_mode & 0o777) == "0o400"


class TestVaultCredentialTypeRegistry:
    def test_every_type_in_mission_scope_is_registered(self):
        expected = {
            "ssh_password", "ssh_private_key", "windows_admin", "winbox", "webfig",
            "api_token", "smtp", "webhook_secret", "snmp_v2", "snmp_v3",
            "generic_username_password",
        }
        assert expected <= set(VAULT_CREDENTIAL_TYPES)

    def test_legacy_types_still_registered(self):
        assert {"password", "ssh_key", "snmp", "certificate"} <= set(VAULT_CREDENTIAL_TYPES)
        assert all(VAULT_CREDENTIAL_TYPES[t].legacy for t in ("password", "ssh_key", "snmp", "certificate"))

    def test_validate_secret_fields_rejects_missing_required(self):
        with pytest.raises(VaultCredentialTypeError):
            validate_secret_fields("ssh_private_key", {})  # private_key required
        cleaned = validate_secret_fields("ssh_private_key", {"private_key": "PEM", "unknown_key": "x"})
        assert cleaned == {"private_key": "PEM"}  # unknown key dropped

    def test_validate_metadata_rejects_missing_required(self):
        with pytest.raises(VaultCredentialTypeError):
            validate_metadata("smtp", {})  # host, port required
        cleaned = validate_metadata("smtp", {"host": "mail.example.com", "port": "587", "bogus": "x"})
        assert cleaned == {"host": "mail.example.com", "port": "587"}

    def test_unknown_type_raises(self):
        with pytest.raises(VaultCredentialTypeError):
            validate_secret_fields("not_a_real_type", {"x": "y"})


class TestVaultService:
    def test_create_stores_no_plaintext_and_audits(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        assert "s3cr3t!" not in credential.ciphertext
        assert credential.scope_type == "global"
        usage = service.usage(credential.id)
        assert [u.action for u in usage] == ["create"]

    def test_scope_integrity(self):
        db = _session()
        device = Device(hostname="SCOPE-TEST")
        db.add(device)
        db.commit()
        db.refresh(device)

        service = VaultService(db)
        with pytest.raises(VaultScopeError):
            service.create(_create_payload(scope_type="client"), created_by="m")  # missing client_id
        with pytest.raises(VaultScopeError):
            service.create(
                _create_payload(scope_type="global", device_id=device.id), created_by="m"
            )  # global must not set targets
        ok = service.create(_create_payload(scope_type="device", device_id=device.id), created_by="m")
        assert ok.device_id == device.id

    def test_reveal_returns_secret_fields_dict_and_audits_reason(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        secret_fields = service.reveal(credential, "mario", reason="emergency ssh access")
        assert secret_fields == {"secret": "s3cr3t!"}
        actions = [u.action for u in service.usage(credential.id)]
        assert "reveal" in actions
        reveal_row = next(u for u in service.usage(credential.id) if u.action == "reveal")
        assert reveal_row.reason == "emergency ssh access"
        assert credential.last_used_at is not None

    def test_reveal_never_logs_or_returns_plaintext_outside_the_dict(self, caplog):
        db = _session()
        service = VaultService(db)
        credential = service.create(_create_payload(secret="top-secret-value"), created_by="mario")
        with caplog.at_level("WARNING"):
            service.reveal(credential, "mario", reason="audit check")
        for record in caplog.records:
            assert "top-secret-value" not in record.getMessage()

    def test_reveal_falls_back_for_legacy_non_json_ciphertext(self):
        # Rows created before 2026-07-10 store the raw secret string directly
        # (no JSON envelope) — reveal must still work without re-encryption.
        db = _session()
        from app.core.vault_cipher import encrypt_secret

        ciphertext, wrapped = encrypt_secret("legacy-raw-secret")  # not JSON
        credential = VaultCredential(
            name="pre-existing", credential_type="password", scope_type="global",
            ciphertext=ciphertext, dek_wrapped=wrapped, created_by="legacy",
        )
        db.add(credential)
        db.commit()
        db.refresh(credential)

        service = VaultService(db)
        assert service.reveal(credential, "mario", reason="migration check") == {"secret": "legacy-raw-secret"}

    def test_rotate_changes_ciphertext_and_sets_rotated_at(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        old_ciphertext = credential.ciphertext
        service.update(credential, VaultCredentialUpdate(secret="new-secret"), "mario")
        assert credential.ciphertext != old_ciphertext
        assert credential.rotated_at is not None
        assert service.reveal(credential, "mario", reason="verify rotation") == {"secret": "new-secret"}

    def test_metadata_stored_and_validated_on_create(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(
            VaultCredentialCreate(
                name="mail relay", credential_type="smtp",
                metadata={"host": "mail.example.com", "port": "587", "tls_mode": "starttls"},
                secret_fields={"password": "smtp-pass"},
            ),
            created_by="mario",
        )
        assert credential.metadata_json is not None
        import json
        assert json.loads(credential.metadata_json) == {"host": "mail.example.com", "port": "587", "tls_mode": "starttls"}

    def test_metadata_missing_required_field_raises(self):
        db = _session()
        service = VaultService(db)
        with pytest.raises(VaultCredentialTypeError):
            service.create(
                VaultCredentialCreate(name="bad smtp", credential_type="smtp", secret_fields={"password": "x"}),
                created_by="mario",
            )

    def test_multi_secret_field_type_round_trips(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(
            VaultCredentialCreate(
                name="router key", credential_type="ssh_private_key", username="admin",
                secret_fields={"private_key": "-----BEGIN KEY-----", "passphrase": "p4ss"},
            ),
            created_by="mario",
        )
        revealed = service.reveal(credential, "mario", reason="deploy check")
        assert revealed == {"private_key": "-----BEGIN KEY-----", "passphrase": "p4ss"}


class TestVaultScopeResolution:
    def _cred(self, db, **overrides):
        service = VaultService(db)
        return service.create(_create_payload(credential_type="generic_username_password", secret_fields={"password": "x"}, **overrides), created_by="m")

    def test_device_beats_client_beats_global(self):
        db = _session()
        client = Client(name="Acme", slug="acme")
        db.add(client)
        db.commit()
        db.refresh(client)
        device = Device(hostname="ACME-PC", client_id=client.id)
        db.add(device)
        db.commit()
        db.refresh(device)

        service = VaultService(db)
        global_cred = self._cred(db, name="global", purpose="ssh_connect")
        client_cred = self._cred(db, name="client", purpose="ssh_connect", scope_type="client", client_id=client.id)
        device_cred = self._cred(db, name="device", purpose="ssh_connect", scope_type="device", device_id=device.id)

        resolved = service.resolve_for_context(purpose="ssh_connect", device_id=device.id, client_id=client.id)
        assert resolved.id == device_cred.id

        # remove the device-scoped one — client should win next
        service.delete(device_cred, "mario", force=True)
        resolved = service.resolve_for_context(purpose="ssh_connect", device_id=device.id, client_id=client.id)
        assert resolved.id == client_cred.id

        # remove the client-scoped one — global wins last
        service.delete(client_cred, "mario", force=True)
        resolved = service.resolve_for_context(purpose="ssh_connect", device_id=device.id, client_id=client.id)
        assert resolved.id == global_cred.id

    def test_disabled_credential_is_never_resolved(self):
        db = _session()
        service = VaultService(db)
        cred = self._cred(db, name="disabled one", purpose="ssh_connect")
        service.set_status(cred, "disabled", "mario")
        assert service.resolve_for_context(purpose="ssh_connect") is None

    def test_purpose_filters_out_non_matching_credentials(self):
        db = _session()
        service = VaultService(db)
        self._cred(db, name="wrong purpose", purpose="snmp_monitoring")
        assert service.resolve_for_context(purpose="ssh_connect") is None

    def test_no_match_returns_none(self):
        db = _session()
        service = VaultService(db)
        assert service.resolve_for_context(purpose="anything") is None


class TestVaultAssignments:
    def test_assignment_blocks_delete_and_force_overrides(self):
        db = _session()
        client = Client(name="Beta Co", slug="beta-co")
        db.add(client)
        db.commit()
        db.refresh(client)

        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        service.add_assignment(credential.id, client_id=client.id, device_id=None, created_by="mario")

        with pytest.raises(VaultReferencedError) as excinfo:
            service.delete(credential, "mario")
        assert any("Beta Co" in ref for ref in excinfo.value.references)

        service.delete(credential, "mario", force=True)
        assert service.get(credential.id) is None

    def test_remove_assignment(self):
        db = _session()
        client = Client(name="Gamma", slug="gamma")
        db.add(client)
        db.commit()
        db.refresh(client)

        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        assignment = service.add_assignment(credential.id, client_id=client.id, device_id=None, created_by="mario")
        assert len(service.list_assignments(credential.id)) == 1
        service.remove_assignment(assignment, "mario")
        assert service.list_assignments(credential.id) == []
        # no longer blocks deletion
        service.delete(credential, "mario")

    def test_assignment_requires_client_or_device(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        with pytest.raises(VaultScopeError):
            service.add_assignment(credential.id, client_id=None, device_id=None, created_by="mario")


def _client(role: str, flag_on: bool, monkeypatch) -> TestClient:
    client, _ = _client_and_db(role, flag_on, monkeypatch)
    return client


def _client_and_db(role: str, flag_on: bool, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", flag_on)
    monkeypatch.setattr(settings, "FEATURE_VAULT", flag_on)
    db = _session()
    app = FastAPI()
    app.include_router(vault_endpoint.router, prefix="/api/v1/vault")
    operator = SimpleNamespace(id=1, username="tester", role=role)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


class TestVaultEndpoints:
    def test_flag_off_means_404_everywhere(self, monkeypatch):
        client = _client(OperatorRole.OWNER.value, flag_on=False, monkeypatch=monkeypatch)
        assert client.get("/api/v1/vault").status_code == 404
        assert client.post("/api/v1/vault", json={}).status_code == 404
        assert client.post("/api/v1/vault/1/reveal", json={"reason": "x" * 10}).status_code == 404
        assert client.get("/api/v1/vault/types").status_code == 404

    def test_crud_and_reveal_flow(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={"name": "srv ssh", "credential_type": "ssh_key", "secret": "KEYDATA"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert "secret" not in body and "ciphertext" not in body
        assert body["secret_hint"].startswith("••••")

        listed = client.get("/api/v1/vault").json()
        assert len(listed) == 1

        reveal = client.post(
            f"/api/v1/vault/{body['id']}/reveal", json={"reason": "pilot verification"}
        )
        assert reveal.status_code == 200
        assert reveal.json()["secret_fields"] == {"secret": "KEYDATA"}

        usage = client.get(f"/api/v1/vault/{body['id']}/usage").json()
        assert {u["action"] for u in usage} >= {"create", "reveal"}

    def test_list_response_never_contains_plaintext_or_ciphertext(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        client.post(
            "/api/v1/vault",
            json={"name": "no leak", "credential_type": "password", "secret": "TOP-SECRET-XYZ"},
        )
        body = client.get("/api/v1/vault").text
        assert "TOP-SECRET-XYZ" not in body
        assert "ciphertext" not in body
        assert "dek_wrapped" not in body

    def test_scope_error_maps_to_422(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        response = client.post(
            "/api/v1/vault",
            json={"name": "x", "credential_type": "password", "secret": "s", "scope_type": "client"},
        )
        assert response.status_code == 422

    def test_credential_type_error_maps_to_422(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        response = client.post(
            "/api/v1/vault",
            json={"name": "bad smtp", "credential_type": "smtp", "secret_fields": {"password": "x"}},
        )
        assert response.status_code == 422

    def test_list_types_returns_full_registry(self, monkeypatch):
        client = _client(OperatorRole.OPERATOR.value, flag_on=True, monkeypatch=monkeypatch)
        response = client.get("/api/v1/vault/types")
        assert response.status_code == 200
        ids = {t["id"] for t in response.json()}
        assert "ssh_password" in ids and "smtp" in ids and "snmp_v3" in ids

    def test_delete_succeeds_removes_from_list_and_audits(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={"name": "unused cred", "credential_type": "password", "secret": "s3cr3t"},
        )
        credential_id = created.json()["id"]

        response = client.delete(f"/api/v1/vault/{credential_id}")
        assert response.status_code == 204

        listed = client.get("/api/v1/vault").json()
        assert listed == []

    def test_delete_with_multiple_usage_rows_reproduces_production_bug(self, monkeypatch):
        # Production incident (2026-07-10): every credential has at least one
        # vault_credential_usage row from creation, and that FK
        # (vault_credential_usage_credential_id_fkey, NO ACTION in Postgres)
        # made every delete fail with a 500 IntegrityError, surfaced to the
        # browser as "Failed to fetch". Reveal/rotate add more usage rows —
        # this locks that a credential with several still deletes cleanly.
        client, db = _client_and_db(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={"name": "well used cred", "credential_type": "password", "secret": "s3cr3t"},
        ).json()
        credential_id = created["id"]
        client.post(f"/api/v1/vault/{credential_id}/reveal", json={"reason": "routine check"})
        client.patch(f"/api/v1/vault/{credential_id}", json={"secret": "new-secret"})
        assert len(client.get(f"/api/v1/vault/{credential_id}/usage").json()) >= 3

        response = client.delete(f"/api/v1/vault/{credential_id}")
        assert response.status_code == 204
        assert client.get("/api/v1/vault").json() == []
        assert db.query(VaultCredentialUsage).filter(
            VaultCredentialUsage.credential_id == credential_id
        ).count() == 0

    def test_delete_denied_for_non_admin(self, monkeypatch):
        client = _client(OperatorRole.OPERATOR.value, flag_on=True, monkeypatch=monkeypatch)
        response = client.delete("/api/v1/vault/1")
        assert response.status_code == 403

    def test_delete_referenced_credential_returns_409_and_is_audited(self, monkeypatch):
        client, db = _client_and_db(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        live_client = Client(name="Acme Corp", slug="acme-corp")
        db.add(live_client)
        db.commit()
        db.refresh(live_client)

        created = client.post(
            "/api/v1/vault",
            json={
                "name": "client-scoped cred",
                "credential_type": "password",
                "secret": "s3cr3t",
                "scope_type": "client",
                "client_id": live_client.id,
            },
        )
        credential_id = created.json()["id"]

        blocked = client.delete(f"/api/v1/vault/{credential_id}")
        assert blocked.status_code == 409
        assert "Acme Corp" in blocked.json()["detail"]

        # still present — the blocked attempt must not have deleted it
        assert len(client.get("/api/v1/vault").json()) == 1
        actions = {row.action for row in db.query(AuditLog).all()}
        assert "vault_credential_delete_blocked" in actions

        forced = client.delete(f"/api/v1/vault/{credential_id}?force=true")
        assert forced.status_code == 204
        assert client.get("/api/v1/vault").json() == []

    def test_delete_orphaned_scope_does_not_block(self, monkeypatch):
        # vault_credentials.device_id has a real, enforced FK in production
        # (confirmed live: vault_credentials_device_id_fkey, NO ACTION), so a
        # credential can never be CREATED pointing at a nonexistent device —
        # this can only arise if the device row is removed by some path that
        # bypasses the ORM relationship (direct SQL). Simulate that via a raw
        # DELETE (same technique production data repair would use) rather
        # than asserting an impossible API-level create.
        client, db = _client_and_db(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        device = Device(hostname="temp-device")
        db.add(device)
        db.commit()
        db.refresh(device)
        created = client.post(
            "/api/v1/vault",
            json={
                "name": "orphaned device cred",
                "credential_type": "password",
                "secret": "s3cr3t",
                "scope_type": "device",
                "device_id": device.id,
            },
        )
        credential_id = created.json()["id"]

        db.execute(text("PRAGMA foreign_keys=OFF"))
        db.query(Device).filter(Device.id == device.id).delete()
        db.commit()
        db.execute(text("PRAGMA foreign_keys=ON"))

        response = client.delete(f"/api/v1/vault/{credential_id}")
        assert response.status_code == 204

    def test_reveal_denied_for_non_admin_without_permission(self, monkeypatch):
        client = _client(OperatorRole.OPERATOR.value, flag_on=True, monkeypatch=monkeypatch)
        response = client.post("/api/v1/vault/1/reveal", json={"reason": "not allowed" * 2})
        assert response.status_code == 403

    def test_status_toggle_disable_enable_and_audit(self, monkeypatch):
        client, db = _client_and_db(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={"name": "toggle me", "credential_type": "password", "secret": "s"},
        ).json()
        disabled = client.post(f"/api/v1/vault/{created['id']}/status", params={"status": "disabled"})
        assert disabled.status_code == 200
        assert disabled.json()["status"] == "disabled"
        assert disabled.json()["lifecycle_status"] == "disabled"

        enabled = client.post(f"/api/v1/vault/{created['id']}/status", params={"status": "active"})
        assert enabled.json()["lifecycle_status"] == "active"

        actions = {row.action for row in db.query(AuditLog).all()}
        assert {"vault_credential_disabled", "vault_credential_enabled"} <= actions

    def test_expiry_lifecycle_badges(self, monkeypatch):
        from datetime import timedelta
        from app.core.time import utcnow

        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        expired = client.post(
            "/api/v1/vault",
            json={
                "name": "expired cred", "credential_type": "password", "secret": "s",
                "expires_at": (utcnow() - timedelta(days=1)).isoformat(),
            },
        ).json()
        soon = client.post(
            "/api/v1/vault",
            json={
                "name": "expiring soon cred", "credential_type": "password", "secret": "s",
                "expires_at": (utcnow() + timedelta(days=3)).isoformat(),
            },
        ).json()
        assert expired["lifecycle_status"] == "expired"
        assert soon["lifecycle_status"] == "expiring_soon"

    def test_assignments_crud_via_api(self, monkeypatch):
        client, db = _client_and_db(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        live_client = Client(name="Delta LLC", slug="delta-llc")
        db.add(live_client)
        db.commit()
        db.refresh(live_client)

        created = client.post(
            "/api/v1/vault",
            json={"name": "assignable", "credential_type": "password", "secret": "s"},
        ).json()
        assigned = client.post(
            f"/api/v1/vault/{created['id']}/assignments", json={"client_id": live_client.id},
        )
        assert assigned.status_code == 200, assigned.text
        assignment_id = assigned.json()["id"]
        assert assigned.json()["client_name"] == "Delta LLC"

        listed = client.get(f"/api/v1/vault/{created['id']}/assignments").json()
        assert len(listed) == 1

        # referenced via assignment → delete blocked
        blocked = client.delete(f"/api/v1/vault/{created['id']}")
        assert blocked.status_code == 409

        removed = client.delete(f"/api/v1/vault/{created['id']}/assignments/{assignment_id}")
        assert removed.status_code == 204

        # no longer referenced → delete succeeds
        assert client.delete(f"/api/v1/vault/{created['id']}").status_code == 204

    def test_assignment_unknown_client_returns_404(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={"name": "x", "credential_type": "password", "secret": "s"},
        ).json()
        response = client.post(f"/api/v1/vault/{created['id']}/assignments", json={"client_id": 999999})
        assert response.status_code == 404

    def test_test_connection_unsupported_type_is_honest(self, monkeypatch):
        client, db = _client_and_db(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={"name": "ssh cred", "credential_type": "ssh_password", "username": "root", "secret_fields": {"password": "x"}},
        ).json()
        response = client.post(f"/api/v1/vault/{created['id']}/test")
        assert response.status_code == 200
        assert response.json()["status"] == "unsupported"
        actions = {row.action for row in db.query(AuditLog).all()}
        assert "vault_credential_test_failed" in actions

    def test_test_connection_webhook_success(self, monkeypatch):
        from app.services import notification_channels

        def fake_send(channel_type, *, config, secret, title, message, event_type, payload=None):
            assert channel_type == "webhook"
            return True, None

        monkeypatch.setattr(notification_channels, "send_via_channel", fake_send)
        client, db = _client_and_db(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={
                "name": "webhook cred", "credential_type": "webhook_secret",
                "metadata": {"url": "https://example.com/hook"},
                "secret_fields": {"secret": "shh"},
            },
        ).json()
        response = client.post(f"/api/v1/vault/{created['id']}/test")
        assert response.status_code == 200
        assert response.json()["status"] == "success"
        actions = {row.action for row in db.query(AuditLog).all()}
        assert "vault_credential_tested" in actions


class TestVaultRBACAdditiveGrant:
    """A team can grant a narrower vault_* permission to a non-admin operator
    without making them a full admin — purely additive over the role floor."""

    def _client_with_team_permission(self, monkeypatch, permission: str):
        # vault.py's `_vault_gate` calls get_operator_permissions() as a plain
        # function (not via Depends), so it must be patched on the vault
        # endpoint module itself, not via app.dependency_overrides.
        monkeypatch.setattr(vault_endpoint, "get_operator_permissions", lambda *a, **k: frozenset({permission}))
        client, db = _client_and_db(OperatorRole.OPERATOR.value, flag_on=True, monkeypatch=monkeypatch)
        return client, db

    def test_operator_without_grant_is_denied(self, monkeypatch):
        client = _client(OperatorRole.OPERATOR.value, flag_on=True, monkeypatch=monkeypatch)
        response = client.post(
            "/api/v1/vault", json={"name": "x", "credential_type": "password", "secret": "s"},
        )
        assert response.status_code == 403

    def test_operator_with_vault_create_grant_can_create(self, monkeypatch):
        client, _ = self._client_with_team_permission(monkeypatch, "vault_create")
        response = client.post(
            "/api/v1/vault", json={"name": "granted", "credential_type": "password", "secret": "s"},
        )
        assert response.status_code == 200, response.text

    def test_vault_create_grant_does_not_imply_delete(self, monkeypatch):
        client, _ = self._client_with_team_permission(monkeypatch, "vault_create")
        created = client.post(
            "/api/v1/vault", json={"name": "granted", "credential_type": "password", "secret": "s"},
        ).json()
        response = client.delete(f"/api/v1/vault/{created['id']}")
        assert response.status_code == 403
