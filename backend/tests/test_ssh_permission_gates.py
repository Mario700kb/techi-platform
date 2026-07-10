"""Embedded SSH Connect — RBAC.

Locks: terminal_open/terminal_view (permission_service.py) gate the SSH
session endpoints exactly like vault.py's `_vault_gate` gates Vault endpoints
(additive-OR on top of the admin+ floor, via the newly-shared
`require_role_or_permission` in app.core.auth); vault_use is required only
when a stored Vault credential is actually consumed, never for a Temporary
Session.
"""

import json

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
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.models.operator import Operator, OperatorRole
from app.models.team import Team, TeamMember
from app.models.terminal_session import TerminalSession
from app.models.vault_credential import VaultCredential, VaultCredentialAssignment, VaultCredentialUsage
from app.models.audit_log import AuditLog
from app.schemas.vault import VaultCredentialCreate
from app.services.permission_service import TERMINAL_OPEN, TERMINAL_VIEW, VAULT_USE
from app.services.vault_service import VaultService


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _build(monkeypatch, role="operator", perms=None):
    for flag in ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT", "FEATURE_TERMINAL"):
        monkeypatch.setattr(settings, flag, True)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", "fleet")
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_DEVICE_IDS", "")
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
            Device.__table__, Client.__table__, DeviceGroup.__table__,
            Operator.__table__, Team.__table__, TeamMember.__table__,
            TerminalSession.__table__, VaultCredential.__table__,
            VaultCredentialUsage.__table__, VaultCredentialAssignment.__table__,
            AuditLog.__table__,
        ],
    )
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=7, hostname="lin-1", platform="linux", capabilities={"terminal": ""},
        device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE, local_ip="10.0.0.5",
    ))
    operator = Operator(
        id=1, username="op1", email="op1@test.com", hashed_password="x", role=role, is_active=True,
    )
    db.add(operator)
    db.commit()
    db.refresh(operator)

    if perms:
        team = Team(name="Team-1", color="#f97316", permissions=json.dumps(perms))
        db.add(team)
        db.commit()
        db.refresh(team)
        db.add(TeamMember(team_id=team.id, operator_id=operator.id))
        db.commit()

    VaultService(db).create(
        VaultCredentialCreate(
            name="device-cred", credential_type="ssh_password", username="root", secret="hunter2",
            scope_type="device", device_id=7,
        ),
        created_by="tester",
    )

    return TestClient(_app_for(db, operator)), db


def _app_for(db, operator) -> FastAPI:
    app = FastAPI()
    app.include_router(terminal_endpoint.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return app


def test_operator_with_no_permissions_cannot_open_ssh_session(monkeypatch):
    client, _ = _build(monkeypatch, role="operator", perms=[])
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 403


def test_operator_with_terminal_open_but_no_vault_use_cannot_use_stored_credential(monkeypatch):
    client, _ = _build(monkeypatch, role="operator", perms=[TERMINAL_OPEN])
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 403
    assert VAULT_USE in r.json()["detail"]


def test_operator_with_terminal_open_and_vault_use_can_connect(monkeypatch):
    client, _ = _build(monkeypatch, role="operator", perms=[TERMINAL_OPEN, VAULT_USE])
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 200, r.text


def test_operator_with_only_terminal_open_can_start_temporary_session(monkeypatch):
    # Temporary Session never touches the Vault, so vault_use isn't required.
    client, _ = _build(monkeypatch, role="operator", perms=[TERMINAL_OPEN])
    r = client.post(
        "/devices/7/ssh/sessions",
        json={"temporary_username": "root", "temporary_password": "swordfish"},
    )
    assert r.status_code == 200, r.text


def test_operator_role_can_always_read_session_detail(monkeypatch):
    # _require_ssh_view's floor is OPERATOR (same choice as vault.py's own
    # _require_view) — any operator-role-or-above already passes; the
    # granted permission exists to lift a BELOW-floor role (readonly) up to
    # view access, not to gate operator role itself.
    client, _ = _build(monkeypatch, role="operator", perms=[TERMINAL_OPEN, VAULT_USE])
    created = client.post("/devices/7/ssh/sessions", json={}).json()
    r = client.get(f"/devices/7/ssh/sessions/{created['session_id']}")
    assert r.status_code == 200


def test_readonly_without_terminal_view_cannot_read_session_detail(monkeypatch):
    admin_client, admin_db = _build(monkeypatch, role="admin", perms=[])
    created = admin_client.post("/devices/7/ssh/sessions", json={}).json()

    readonly = Operator(
        id=2, username="ro1", email="ro1@test.com", hashed_password="x", role="readonly", is_active=True,
    )
    admin_db.add(readonly)
    admin_db.commit()

    readonly_client = TestClient(_app_for(admin_db, readonly))
    r = readonly_client.get(f"/devices/7/ssh/sessions/{created['session_id']}")
    assert r.status_code == 403


def test_readonly_with_terminal_view_can_read_session_detail(monkeypatch):
    admin_client, admin_db = _build(monkeypatch, role="admin", perms=[])
    created = admin_client.post("/devices/7/ssh/sessions", json={}).json()

    readonly = Operator(
        id=2, username="ro2", email="ro2@test.com", hashed_password="x", role="readonly", is_active=True,
    )
    admin_db.add(readonly)
    admin_db.commit()
    admin_db.refresh(readonly)
    team = Team(name="Viewers", color="#f97316", permissions=json.dumps([TERMINAL_VIEW]))
    admin_db.add(team)
    admin_db.commit()
    admin_db.refresh(team)
    admin_db.add(TeamMember(team_id=team.id, operator_id=readonly.id))
    admin_db.commit()

    readonly_client = TestClient(_app_for(admin_db, readonly))
    r = readonly_client.get(f"/devices/7/ssh/sessions/{created['session_id']}")
    assert r.status_code == 200


def test_readonly_operator_denied_even_with_terminal_view_only(monkeypatch):
    # terminal_open (not terminal_view) gates session creation — a readonly
    # operator granted only the view permission still cannot open a session.
    client, _ = _build(monkeypatch, role="readonly", perms=[TERMINAL_VIEW])
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 403


def test_admin_bypasses_every_gate_with_no_team_permissions(monkeypatch):
    client, _ = _build(monkeypatch, role="admin", perms=[])
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 200, r.text
    session_id = r.json()["session_id"]
    r2 = client.get(f"/devices/7/ssh/sessions/{session_id}")
    assert r2.status_code == 200


def test_owner_bypasses_every_gate_with_no_team_permissions(monkeypatch):
    client, _ = _build(monkeypatch, role="owner", perms=[])
    r = client.post("/devices/7/ssh/sessions", json={})
    assert r.status_code == 200, r.text
