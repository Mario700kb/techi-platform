"""Embedded SSH Connect — session endpoints (flag + rollout-scope + Vault
resolution gated). Reuses the exact FEATURE_TERMINAL/rollout machinery Phase
5's Web Terminal already ships with (see test_terminal_endpoint.py for the
agent-PTY equivalent of every gate below)."""

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


def _client(
    monkeypatch,
    flag_on: bool = True,
    capabilities=None,
    platform: str = "linux",
    scope: str = "device",
    devices: str = "7",
    local_ip: str = "10.0.0.5",
):
    for flag in ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT", "FEATURE_TERMINAL"):
        monkeypatch.setattr(settings, flag, flag_on)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", scope)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_DEVICE_IDS", devices)
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
            Device.__table__,
            Client.__table__,
            DeviceGroup.__table__,
            Operator.__table__,
            TerminalSession.__table__,
            VaultCredential.__table__,
            VaultCredentialUsage.__table__,
            VaultCredentialAssignment.__table__,
            AuditLog.__table__,
        ],
    )
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=7, hostname="lin-1", platform=platform, capabilities=capabilities or {"terminal": ""},
        device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE, local_ip=local_ip,
    ))
    db.add(Operator(
        id=1, username="mario", email="mario@example.com", hashed_password="x", role=OperatorRole.ADMIN.value,
    ))
    db.commit()

    app = FastAPI()
    app.include_router(terminal_endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=OperatorRole.ADMIN.value)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def _add_ssh_credential(db, **overrides):
    data = dict(name="device-cred", credential_type="ssh_password", scope_type="device",
                device_id=7, username="root", secret="hunter2")
    data.update(overrides)
    return VaultService(db).create(VaultCredentialCreate(**data), created_by="tester")


# ── GET /devices/{id}/ssh/credentials ──────────────────────────────────── #

def test_credentials_404_when_flag_off(monkeypatch):
    client, _ = _client(monkeypatch, flag_on=False)
    r = client.get("/devices/7/ssh/credentials")
    assert r.status_code == 404


def test_credentials_empty_when_none_configured(monkeypatch):
    client, _ = _client(monkeypatch)
    r = client.get("/devices/7/ssh/credentials")
    assert r.status_code == 200
    assert r.json() == {"tier": "none", "candidates": []}


def test_credentials_returns_device_scoped_candidate(monkeypatch):
    client, db = _client(monkeypatch)
    _add_ssh_credential(db)
    r = client.get("/devices/7/ssh/credentials")
    assert r.status_code == 200
    body = r.json()
    assert body["tier"] == "device"
    assert len(body["candidates"]) == 1
    assert body["candidates"][0]["username"] == "root"


# ── POST /devices/{id}/ssh/sessions ────────────────────────────────────── #

def test_create_session_404_when_flag_off(monkeypatch):
    client, _ = _client(monkeypatch, flag_on=False)
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 404


def test_create_session_400_when_device_has_no_ssh_method(monkeypatch):
    # Windows devices declare only "remote_support" as a Connect method.
    client, _ = _client(monkeypatch, platform="windows", capabilities={})
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 400


def test_create_session_403_outside_rollout_scope(monkeypatch):
    client, db = _client(monkeypatch, scope="none")
    _add_ssh_credential(db)
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 403
    rows = db.query(AuditLog).filter(AuditLog.action == "terminal_session_denied").all()
    assert len(rows) == 1
    assert json.loads(rows[0].details_json)["mode"] == "ssh"


def test_create_session_409_when_no_ip(monkeypatch):
    client, db = _client(monkeypatch, local_ip=None)
    _add_ssh_credential(db)
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 409


def test_create_session_409_and_audited_when_credential_missing(monkeypatch):
    client, db = _client(monkeypatch)
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 409
    assert "No SSH credential" in r.json()["detail"]
    rows = db.query(AuditLog).filter(AuditLog.action == "ssh_credential_missing").all()
    assert len(rows) == 1


def test_create_session_409_when_multiple_candidates_and_none_chosen(monkeypatch):
    client, db = _client(monkeypatch)
    _add_ssh_credential(db, name="cred-a")
    _add_ssh_credential(db, name="cred-b")
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 409
    assert "2 SSH credentials" in r.json()["detail"]


def test_create_session_auto_connects_with_single_candidate(monkeypatch):
    client, db = _client(monkeypatch)
    cred = _add_ssh_credential(db)
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["session_id"]
    assert body["operator_ws_path"].startswith("wss://")
    assert f"/ws/terminal/{body['session_id']}" in body["operator_ws_path"]
    assert body["ssh_username"] == "root"
    assert body["credential_source"] == "device"

    session = db.query(TerminalSession).filter(TerminalSession.id == body["session_id"]).one()
    assert session.mode == "ssh"
    assert session.vault_credential_id == cred.id
    assert session.ssh_username == "root"
    assert session.credential_source == "device"

    resolved_actions = [json.loads(a.details_json) for a in db.query(AuditLog).all()]
    action_names = [a.action for a in db.query(AuditLog).all()]
    assert "ssh_credential_resolved" in action_names
    assert "ssh_session_started" in action_names


def test_create_session_with_explicit_credential_id_among_multiple(monkeypatch):
    client, db = _client(monkeypatch)
    _add_ssh_credential(db, name="cred-a")
    cred_b = _add_ssh_credential(db, name="cred-b", username="admin")
    r = client.post("/devices/7/ssh/sessions", json={"credential_id": cred_b.id})
    assert r.status_code == 200, r.text
    assert r.json()["ssh_username"] == "admin"


def test_create_session_404_when_credential_id_not_a_candidate(monkeypatch):
    client, db = _client(monkeypatch)
    _add_ssh_credential(db)
    r = client.post("/devices/7/ssh/sessions", json={"credential_id": 999})
    assert r.status_code == 404


def test_create_session_with_temporary_credentials_skips_vault(monkeypatch):
    client, db = _client(monkeypatch)
    r = client.post(
        "/devices/7/ssh/sessions",
        json={"temporary_username": "root", "temporary_password": "swordfish"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ssh_username"] == "root"
    assert body["credential_source"] == "temporary"
    session = db.query(TerminalSession).filter(TerminalSession.id == body["session_id"]).one()
    assert session.vault_credential_id is None
    assert session.credential_source == "temporary"
    # Never guesses/asks unless temporary was explicit — no credential audit fired.
    action_names = [a.action for a in db.query(AuditLog).all()]
    assert "ssh_credential_resolved" not in action_names
    assert "ssh_credential_missing" not in action_names


def test_create_session_credential_with_no_secret_returns_409(monkeypatch):
    client, db = _client(monkeypatch)
    # A credential type validation would normally prevent this, but guard the
    # connect path defensively too.
    cred = _add_ssh_credential(db)
    cred.ciphertext, cred.dek_wrapped = vault_cipher.encrypt_secret("{}")
    db.commit()
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 409
    assert "no usable secret" in r.json()["detail"].lower()


# ── GET /devices/{id}/ssh/sessions/{session_id} ────────────────────────── #

def test_get_session_detail_after_create(monkeypatch):
    client, db = _client(monkeypatch)
    db.add(Client(id=100, name="Acme", slug="acme"))
    db.commit()
    device = db.query(Device).filter(Device.id == 7).one()
    device.client_id = 100
    db.commit()
    _add_ssh_credential(db)

    created = client.post("/devices/7/ssh/sessions", json={}).json()
    r = client.get(f"/devices/7/ssh/sessions/{created['session_id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["device_hostname"] == "lin-1"
    assert body["client_name"] == "Acme"
    assert body["operator_username"] == "mario"
    assert body["ssh_username"] == "root"
    assert body["credential_source"] == "device"
    assert body["status"] == "pending"


def test_get_session_detail_404_for_wrong_device(monkeypatch):
    client, db = _client(monkeypatch)
    _add_ssh_credential(db)
    created = client.post("/devices/7/ssh/sessions", json={}).json()
    r = client.get(f"/devices/999/ssh/sessions/{created['session_id']}")
    assert r.status_code == 404


def test_get_session_detail_404_for_unknown_session(monkeypatch):
    client, _ = _client(monkeypatch)
    r = client.get("/devices/7/ssh/sessions/does-not-exist")
    assert r.status_code == 404
