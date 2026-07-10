"""Production bug report: "SSH shows username 'root' automatically,
apparently derived from heartbeat/current-user data." Investigation found
no such code path — Device.current_user (the OS-logged-in username reported
by heartbeat) is never read by the SSH connect flow. These regression tests
pin that invariant so it can never be introduced silently:

  Device.current_user is informational only. It must never become an SSH/
  Winbox/WebFig username, password, key, or any authentication fallback.
  Authentication only ever comes from (1) an explicitly selected/resolved
  Vault credential, or (2) an explicit Temporary Session the operator typed
  in themselves.
"""

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.vault_cipher as vault_cipher
from app.api.v1.endpoints import terminal as terminal_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.models.operator import Operator, OperatorRole
from app.models.terminal_session import TerminalSession
from app.models.vault_credential import VaultCredential, VaultCredentialAssignment, VaultCredentialUsage
from app.schemas.vault import VaultCredentialCreate
from app.services.vault_service import VaultService


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _client(monkeypatch, current_user: str = "root", local_ip: str = "10.0.0.5"):
    for flag in ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT", "FEATURE_TERMINAL"):
        monkeypatch.setattr(settings, flag, True)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", "device")
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_DEVICE_IDS", "7")
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_GROUPS", "")
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_CLIENTS", "")

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_connection, _):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(
        bind=engine,
        tables=[
            Device.__table__, Client.__table__, DeviceGroup.__table__, Operator.__table__,
            TerminalSession.__table__, VaultCredential.__table__, VaultCredentialUsage.__table__,
            VaultCredentialAssignment.__table__, AuditLog.__table__,
        ],
    )
    db = sessionmaker(bind=engine)()
    # The exact scenario from the bug report: a device whose heartbeat
    # reports current_user="root" (or any OS-logged-in username).
    db.add(Device(
        id=7, hostname="lin-1", platform="linux", capabilities={"terminal": ""},
        device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE, local_ip=local_ip,
        current_user=current_user,
    ))
    db.add(Operator(id=1, username="mario", email="mario@example.com", hashed_password="x", role=OperatorRole.ADMIN.value))
    db.commit()

    app = FastAPI()
    app.include_router(terminal_endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=OperatorRole.ADMIN.value)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def test_current_user_root_with_no_vault_credential_is_never_used_as_ssh_username(monkeypatch):
    """The core bug report scenario: device.current_user == "root", but NO
    Vault credential exists. The connect attempt must fail with "credential
    missing" — current_user must NOT be silently promoted into an SSH
    session."""
    client, db = _client(monkeypatch, current_user="root")
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 409
    assert "No SSH credential" in r.json()["detail"]
    # No session was ever created with "root" (or any) as ssh_username.
    assert db.query(TerminalSession).count() == 0


def test_current_user_root_does_not_override_a_different_resolved_credential_username(monkeypatch):
    """device.current_user == "root" but the resolved Vault credential's
    real username is "alice" — the session must use "alice", proving
    current_user is never consulted even when a credential DOES resolve."""
    client, db = _client(monkeypatch, current_user="root")
    VaultService(db).create(
        VaultCredentialCreate(
            name="device-cred", credential_type="ssh_password", scope_type="device",
            device_id=7, username="alice", secret="hunter2",
        ),
        created_by="tester",
    )
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 200, r.text
    assert r.json()["ssh_username"] == "alice"


def test_current_user_field_never_appears_in_ssh_candidate_resolution(monkeypatch):
    """resolve_ssh_candidates must derive candidates purely from the Vault —
    device.current_user is not even read by the resolution path."""
    client, db = _client(monkeypatch, current_user="root")
    device = db.query(Device).filter(Device.id == 7).one()
    tier, candidates = VaultService(db).resolve_ssh_candidates(device)
    assert tier == "none"
    assert candidates == []


def test_temporary_session_requires_explicit_operator_input_not_current_user(monkeypatch):
    """A Temporary Session must come from what the operator actually typed —
    device.current_user must never pre-fill or silently substitute for it."""
    client, db = _client(monkeypatch, current_user="root")
    # Operator explicitly supplies a DIFFERENT username than current_user.
    r = client.post(
        "/devices/7/ssh/sessions",
        json={"temporary_username": "explicit-operator-input", "temporary_password": "swordfish"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ssh_username"] == "explicit-operator-input"
    assert r.json()["credential_source"] == "temporary"


def test_current_user_absent_entirely_behaves_identically(monkeypatch):
    """A device that has never reported a current_user (None) must resolve
    credentials identically to one reporting "root" — proving the field has
    zero influence either way."""
    client, db = _client(monkeypatch, current_user=None)
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 409
    assert "No SSH credential" in r.json()["detail"]
