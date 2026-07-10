"""Embedded SSH Connect — Credential Vault resolution.

Locks: VaultService.resolve_ssh_candidates() precedence (Device > Group >
Client > Global), returning every candidate at the first non-empty tier
(never mixing tiers, never guessing across tiers), and
record_credential_use()/enrich()'s "Used By: Embedded SSH" + last_used_at.
"""

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.vault_cipher as vault_cipher
from app.core.config import settings
from app.db.base import Base
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.models.vault_credential import VaultCredential, VaultCredentialAssignment, VaultCredentialUsage
from app.schemas.vault import VaultCredentialCreate
from app.services.vault_service import VaultService


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

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
        ],
    )
    return sessionmaker(bind=engine)()


def _device(db, **overrides):
    data = dict(
        id=7, hostname="lin-1", platform="linux", capabilities={"terminal": ""},
        device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE,
    )
    data.update(overrides)
    device = Device(**data)
    db.add(device)
    db.commit()
    return device


def _ssh_cred(svc, **overrides):
    data = dict(name="cred", credential_type="ssh_password", username="root", secret="hunter2")
    data.update(overrides)
    return svc.create(VaultCredentialCreate(**data), created_by="tester")


class TestResolveSshCandidates:
    def test_no_candidates_returns_none_tier(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "none"
        assert candidates == []

    def test_device_scoped_takes_precedence_over_global(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        _ssh_cred(svc, name="global-cred", scope_type="global")
        _ssh_cred(svc, name="device-cred", scope_type="device", device_id=device.id)
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "device"
        assert [c.name for c in candidates] == ["device-cred"]

    def test_client_scoped_used_when_no_device_or_group_match(self):
        db = _session()
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.commit()
        device = _device(db, client_id=100)
        svc = VaultService(db)
        _ssh_cred(svc, name="global-cred", scope_type="global")
        _ssh_cred(svc, name="client-cred", scope_type="client", client_id=100)
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "client"
        assert [c.name for c in candidates] == ["client-cred"]

    def test_group_scoped_beats_client_scoped(self):
        db = _session()
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.add(DeviceGroup(id=5, name="Servers", client_id=100))
        db.commit()
        device = _device(db, client_id=100, group_id=5)
        svc = VaultService(db)
        _ssh_cred(svc, name="client-cred", scope_type="client", client_id=100)
        _ssh_cred(svc, name="group-cred", scope_type="group", group_id=5)
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "group"
        assert [c.name for c in candidates] == ["group-cred"]

    def test_multiple_candidates_at_same_tier_all_returned(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        _ssh_cred(svc, name="device-cred-a", scope_type="device", device_id=device.id)
        _ssh_cred(svc, name="device-cred-b", scope_type="device", device_id=device.id)
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "device"
        assert sorted(c.name for c in candidates) == ["device-cred-a", "device-cred-b"]

    def test_disabled_credential_excluded(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        cred = _ssh_cred(svc, name="device-cred", scope_type="device", device_id=device.id)
        svc.set_status(cred, "disabled", "tester")
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "none"
        assert candidates == []

    def test_non_ssh_credential_type_excluded(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        _ssh_cred(svc, name="winbox-cred", credential_type="winbox", scope_type="device", device_id=device.id, secret="x")
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "none"
        assert candidates == []

    def test_legacy_ssh_key_type_included(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        _ssh_cred(
            svc, name="legacy-key", credential_type="ssh_key", scope_type="device",
            device_id=device.id, secret="-----BEGIN KEY-----",
        )
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "device"
        assert candidates[0].credential_type == "ssh_key"

    def test_wrong_device_group_client_not_matched(self):
        db = _session()
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.add(Client(id=200, name="Other", slug="other"))
        db.commit()
        device = _device(db, client_id=100)
        svc = VaultService(db)
        _ssh_cred(svc, name="other-client-cred", scope_type="client", client_id=200)
        tier, candidates = svc.resolve_ssh_candidates(device)
        assert tier == "none"
        assert candidates == []


class TestRecordCredentialUse:
    def test_updates_last_used_at_and_writes_use_row(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        cred = _ssh_cred(svc, name="device-cred", scope_type="device", device_id=device.id)
        assert cred.last_used_at is None

        svc.record_credential_use(cred, "mario", device.id)

        db.refresh(cred)
        assert cred.last_used_at is not None
        rows = (
            db.query(VaultCredentialUsage)
            .filter(VaultCredentialUsage.credential_id == cred.id, VaultCredentialUsage.action == "use")
            .all()
        )
        assert len(rows) == 1
        assert rows[0].operator_username == "mario"
        assert rows[0].device_id == device.id

    def test_enrich_reports_used_by_embedded_ssh_after_use(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        cred = _ssh_cred(svc, name="device-cred", scope_type="device", device_id=device.id)

        assert svc.enrich(cred)["used_by"] == []

        svc.record_credential_use(cred, "mario", device.id)
        assert svc.enrich(cred)["used_by"] == ["Embedded SSH"]

    def test_get_secret_fields_for_use_does_not_write_reveal_row(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        cred = _ssh_cred(svc, name="device-cred", scope_type="device", device_id=device.id, secret="hunter2")

        fields = svc.get_secret_fields_for_use(cred)
        assert fields["password"] == "hunter2"

        rows = svc.usage(cred.id)
        assert all(r.action != "reveal" for r in rows)


class TestResolveCredentialsForMethod:
    """Generic Connect-method credential resolution (Section D/F): Winbox and
    WebFig get the same Device>Group>Client>Global precedence as SSH, matched
    by credential TYPE — never an unrelated type."""

    def test_winbox_matches_only_winbox_type(self):
        db = _session()
        device = _device(db, platform="mikrotik", capabilities={"connect": ""})
        svc = VaultService(db)
        _ssh_cred(svc, name="ssh-cred", credential_type="ssh_password", scope_type="device", device_id=device.id)
        _ssh_cred(svc, name="winbox-cred", credential_type="winbox", scope_type="device", device_id=device.id, secret="x")
        tier, candidates = svc.resolve_credentials_for_method(device, "winbox")
        assert tier == "device"
        assert [c.name for c in candidates] == ["winbox-cred"]

    def test_webfig_matches_webfig_type(self):
        db = _session()
        device = _device(db, platform="mikrotik", capabilities={"connect": ""})
        svc = VaultService(db)
        _ssh_cred(svc, name="webfig-cred", credential_type="webfig", scope_type="device", device_id=device.id, secret="x")
        tier, candidates = svc.resolve_credentials_for_method(device, "webfig")
        assert tier == "device"
        assert [c.name for c in candidates] == ["webfig-cred"]

    def test_webfig_matches_generic_username_password_only_when_purpose_marked(self):
        db = _session()
        device = _device(db, platform="mikrotik", capabilities={"connect": ""})
        svc = VaultService(db)
        _ssh_cred(
            svc, name="unmarked-generic", credential_type="generic_username_password",
            scope_type="device", device_id=device.id, secret="x",
        )
        tier, candidates = svc.resolve_credentials_for_method(device, "webfig")
        assert tier == "none"
        assert candidates == []

        _ssh_cred(
            svc, name="marked-generic", credential_type="generic_username_password",
            scope_type="device", device_id=device.id, secret="x", purpose="WebFig login",
        )
        tier, candidates = svc.resolve_credentials_for_method(device, "webfig")
        assert tier == "device"
        assert [c.name for c in candidates] == ["marked-generic"]

    def test_winbox_does_not_match_unrelated_type_even_by_name(self):
        db = _session()
        device = _device(db, platform="mikrotik", capabilities={"connect": ""})
        svc = VaultService(db)
        _ssh_cred(svc, name="webfig-cred", credential_type="webfig", scope_type="device", device_id=device.id, secret="x")
        tier, candidates = svc.resolve_credentials_for_method(device, "winbox")
        assert tier == "none"
        assert candidates == []

    def test_unknown_method_returns_none(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        tier, candidates = svc.resolve_credentials_for_method(device, "remote_support")
        assert tier == "none"
        assert candidates == []

    def test_ssh_still_works_through_generic_resolver(self):
        db = _session()
        device = _device(db)
        svc = VaultService(db)
        _ssh_cred(svc, name="device-cred", scope_type="device", device_id=device.id)
        tier, candidates = svc.resolve_credentials_for_method(device, "ssh")
        assert tier == "device"
        assert [c.name for c in candidates] == ["device-cred"]

    def test_winbox_precedence_device_over_global(self):
        db = _session()
        device = _device(db, platform="mikrotik", capabilities={"connect": ""})
        svc = VaultService(db)
        _ssh_cred(svc, name="global-winbox", credential_type="winbox", scope_type="global", secret="x")
        _ssh_cred(svc, name="device-winbox", credential_type="winbox", scope_type="device", device_id=device.id, secret="x")
        tier, candidates = svc.resolve_credentials_for_method(device, "winbox")
        assert tier == "device"
        assert [c.name for c in candidates] == ["device-winbox"]
