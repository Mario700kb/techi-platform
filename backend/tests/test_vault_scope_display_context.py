"""Production bug fix — Vault scope assignment + derived display context.

Locks:
  - VaultService._validate_scope still correctly REJECTS a Device-scoped
    payload that also carries client_id/group_id (this was never a backend
    bug — the frontend was sending client_id when scope="device"; see
    CredentialVaultScopeForm.test.tsx for the frontend-side regression
    coverage). These tests prove the backend's existing contract, so a
    future regression on either side is caught.
  - VaultService.resolve_display_context()/enrich() derive Client/Group
    display names for Group- and Device-scoped credentials WITHOUT ever
    storing them on the row (scope integrity is unchanged).
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
from app.services.vault_service import VaultScopeError, VaultService


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
            VaultCredential.__table__, VaultCredentialUsage.__table__, VaultCredentialAssignment.__table__,
            AuditLog.__table__, Client.__table__, DeviceGroup.__table__, Device.__table__,
        ],
    )
    return sessionmaker(bind=engine)()


def _cred_payload(**overrides):
    data = dict(name="cred", credential_type="generic_username_password", secret="s3cr3t!")
    data.update(overrides)
    return VaultCredentialCreate(**data)


class TestScopeValidationContract:
    """The exact production bug: frontend sent client_id alongside
    scope="device". Confirms the backend's rejection is correct and stays
    that way — the fix belongs entirely on the frontend (payload
    construction), not here."""

    def test_device_scope_rejects_client_id(self):
        db = _session()
        svc = VaultService(db)
        db.add(Device(id=733, hostname="mario-home", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE))
        db.commit()
        with pytest.raises(VaultScopeError, match="must not set client_id"):
            svc.create(_cred_payload(scope_type="device", device_id=733, client_id=100), created_by="tester")

    def test_device_scope_rejects_group_id(self):
        db = _session()
        svc = VaultService(db)
        db.add(Device(id=733, hostname="mario-home", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE))
        db.commit()
        with pytest.raises(VaultScopeError, match="must not set group_id"):
            svc.create(_cred_payload(scope_type="device", device_id=733, group_id=5), created_by="tester")

    def test_device_scope_with_only_device_id_succeeds(self):
        db = _session()
        svc = VaultService(db)
        db.add(Device(id=733, hostname="mario-home", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE))
        db.commit()
        cred = svc.create(_cred_payload(scope_type="device", device_id=733), created_by="tester")
        assert cred.device_id == 733
        assert cred.client_id is None
        assert cred.group_id is None

    def test_group_scope_rejects_client_id(self):
        db = _session()
        svc = VaultService(db)
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.add(DeviceGroup(id=5, name="Network", client_id=100))
        db.commit()
        with pytest.raises(VaultScopeError, match="must not set client_id"):
            svc.create(_cred_payload(scope_type="group", group_id=5, client_id=100), created_by="tester")

    def test_group_scope_with_only_group_id_succeeds(self):
        db = _session()
        svc = VaultService(db)
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.add(DeviceGroup(id=5, name="Network", client_id=100))
        db.commit()
        cred = svc.create(_cred_payload(scope_type="group", group_id=5), created_by="tester")
        assert cred.group_id == 5
        assert cred.client_id is None
        assert cred.device_id is None

    def test_client_scope_requires_client_id(self):
        db = _session()
        svc = VaultService(db)
        with pytest.raises(VaultScopeError, match="requires client_id"):
            svc.create(_cred_payload(scope_type="client"), created_by="tester")


class TestResolveDisplayContext:
    def test_global_scope_has_no_context(self):
        db = _session()
        svc = VaultService(db)
        cred = svc.create(_cred_payload(scope_type="global"), created_by="tester")
        ctx = svc.resolve_display_context(cred)
        assert ctx == {
            "device_hostname": None, "context_client_id": None, "context_client_name": None,
            "context_group_id": None, "context_group_name": None,
        }

    def test_client_scope_shows_client_name(self):
        db = _session()
        svc = VaultService(db)
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.commit()
        cred = svc.create(_cred_payload(scope_type="client", client_id=100), created_by="tester")
        ctx = svc.resolve_display_context(cred)
        assert ctx["context_client_id"] == 100
        assert ctx["context_client_name"] == "Acme"
        assert ctx["context_group_name"] is None
        assert ctx["device_hostname"] is None

    def test_group_scope_derives_client_through_group(self):
        db = _session()
        svc = VaultService(db)
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.add(DeviceGroup(id=5, name="Network", client_id=100))
        db.commit()
        cred = svc.create(_cred_payload(scope_type="group", group_id=5), created_by="tester")
        ctx = svc.resolve_display_context(cred)
        assert ctx["context_group_id"] == 5
        assert ctx["context_group_name"] == "Network"
        assert ctx["context_client_id"] == 100
        assert ctx["context_client_name"] == "Acme"

    def test_device_scope_derives_client_and_group_through_device(self):
        db = _session()
        svc = VaultService(db)
        db.add(Client(id=100, name="TECHI shpk", slug="techi"))
        db.add(DeviceGroup(id=5, name="Network", client_id=100))
        db.add(Device(
            id=733, hostname="mario-home", display_name="Mario Home", client_id=100, group_id=5,
            device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE,
        ))
        db.commit()
        cred = svc.create(_cred_payload(scope_type="device", device_id=733), created_by="tester")
        ctx = svc.resolve_display_context(cred)
        assert ctx["device_hostname"] == "Mario Home"
        assert ctx["context_client_id"] == 100
        assert ctx["context_client_name"] == "TECHI shpk"
        assert ctx["context_group_id"] == 5
        assert ctx["context_group_name"] == "Network"

    def test_device_scope_with_no_client_or_group_assigned(self):
        db = _session()
        svc = VaultService(db)
        db.add(Device(id=733, hostname="mario-home", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE))
        db.commit()
        cred = svc.create(_cred_payload(scope_type="device", device_id=733), created_by="tester")
        ctx = svc.resolve_display_context(cred)
        assert ctx["device_hostname"] == "mario-home"
        assert ctx["context_client_id"] is None
        assert ctx["context_group_id"] is None

    def test_enrich_includes_display_context(self):
        db = _session()
        svc = VaultService(db)
        db.add(Client(id=100, name="Acme", slug="acme"))
        db.add(DeviceGroup(id=5, name="Network", client_id=100))
        db.commit()
        cred = svc.create(_cred_payload(scope_type="group", group_id=5), created_by="tester")
        enriched = svc.enrich(cred)
        assert enriched["context_client_name"] == "Acme"
        assert enriched["context_group_name"] == "Network"
