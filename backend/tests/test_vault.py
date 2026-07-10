"""Phase 4 — Enterprise Credential Vault tests.

Locks: AES-256-GCM envelope round-trip + tamper detection, scope integrity,
usage audit on every access, reveal semantics, and the flag-off invisibility
contract (404 on every route when FEATURE_VAULT is off).
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
from app.models.vault_credential import VaultCredential, VaultCredentialUsage
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
            AuditLog.__table__,
            Client.__table__,
            DeviceGroup.__table__,
            Device.__table__,
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

    def test_reveal_returns_plaintext_and_audits_reason(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        secret = service.reveal(credential, "mario", reason="emergency ssh access")
        assert secret == "s3cr3t!"
        actions = [u.action for u in service.usage(credential.id)]
        assert "reveal" in actions
        reveal_row = next(u for u in service.usage(credential.id) if u.action == "reveal")
        assert reveal_row.reason == "emergency ssh access"
        assert credential.last_used_at is not None

    def test_rotate_changes_ciphertext_and_sets_rotated_at(self):
        db = _session()
        service = VaultService(db)
        credential = service.create(_create_payload(), created_by="mario")
        old_ciphertext = credential.ciphertext
        service.update(credential, VaultCredentialUpdate(secret="new-secret"), "mario")
        assert credential.ciphertext != old_ciphertext
        assert credential.rotated_at is not None
        assert service.reveal(credential, "mario", reason="verify rotation") == "new-secret"


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

    def test_crud_and_reveal_flow(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        created = client.post(
            "/api/v1/vault",
            json={"name": "srv ssh", "credential_type": "ssh_key", "secret": "KEYDATA"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert "secret" not in body and body["secret_hint"].startswith("••••")

        listed = client.get("/api/v1/vault").json()
        assert len(listed) == 1

        reveal = client.post(
            f"/api/v1/vault/{body['id']}/reveal", json={"reason": "pilot verification"}
        )
        assert reveal.status_code == 200
        assert reveal.json()["secret"] == "KEYDATA"

        usage = client.get(f"/api/v1/vault/{body['id']}/usage").json()
        assert {u["action"] for u in usage} >= {"create", "reveal"}

    def test_scope_error_maps_to_422(self, monkeypatch):
        client = _client(OperatorRole.ADMIN.value, flag_on=True, monkeypatch=monkeypatch)
        response = client.post(
            "/api/v1/vault",
            json={"name": "x", "credential_type": "password", "secret": "s", "scope_type": "client"},
        )
        assert response.status_code == 422

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

    def test_delete_referenced_credential_returns_409(self, monkeypatch):
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


class TestVaultServiceReferences:
    def test_blocking_references_lists_live_device(self):
        db = _session()
        device = Device(hostname="WIN-ABC123", display_name="WIN-ABC123")
        db.add(device)
        db.commit()
        db.refresh(device)

        service = VaultService(db)
        credential = service.create(
            _create_payload(scope_type="device", device_id=device.id), created_by="mario"
        )
        references = service.blocking_references(credential)
        assert references == [f"Device #{device.id} (WIN-ABC123)"]

        with pytest.raises(VaultReferencedError):
            service.delete(credential, "mario")

        # force=True bypasses the guard
        service.delete(credential, "mario", force=True)
        assert service.get(credential.id) is None
