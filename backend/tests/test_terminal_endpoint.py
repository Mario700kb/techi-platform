"""Phase 5 — Web Terminal session endpoint (flag + rollout-scope gated)."""

import json
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import terminal as terminal_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import OperatorRole


def _client(
    monkeypatch,
    flag_on: bool,
    capabilities=None,
    scope: str = "device",
    devices: str = "7",
    groups: str = "",
    clients: str = "",
    device_group_id=None,
    device_client_id=None,
):
    # FEATURE_TERMINAL depends on CORE+LINUX+VAULT (fail-closed dependency chain).
    for flag in ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT", "FEATURE_TERMINAL"):
        monkeypatch.setattr(settings, flag, flag_on)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", scope)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_DEVICE_IDS", devices)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_GROUPS", groups)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_CLIENTS", clients)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=7, hostname="lin-1", platform="linux", capabilities=capabilities,
        device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE,
        group_id=device_group_id, client_id=device_client_id,
    ))
    db.commit()
    app = FastAPI()
    app.include_router(terminal_endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=OperatorRole.ADMIN.value)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def _client_only(*args, **kwargs):
    client, _ = _client(*args, **kwargs)
    return client


def test_404_when_flag_off(monkeypatch):
    client = _client_only(monkeypatch, flag_on=False, capabilities={"terminal": ""})
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 404


def test_400_when_device_lacks_terminal_capability(monkeypatch):
    client = _client_only(monkeypatch, flag_on=True, capabilities={"docker": "26.1"})
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 400


def test_creates_session_and_returns_ws_path(monkeypatch):
    client, db = _client(monkeypatch, flag_on=True, capabilities={"terminal": "", "bash": ""})
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["session_id"]
    assert body["operator_ws_path"].startswith("wss://")
    assert f"/ws/terminal/{body['session_id']}" in body["operator_ws_path"]
    assert body["operator_ticket"] in body["operator_ws_path"]
    # Was pinned at 60 until 2026-08-04. That flat value was shorter than every
    # heartbeat interval, and the agent only learns about the session on its
    # next heartbeat — so the ticket routinely expired before delivery. Assert
    # the invariant rather than a number: the ticket must outlive a full
    # heartbeat cycle for this device's platform.
    from app.services import agent_config_service as _cfg
    from app.services.terminal_service import TICKET_ATTACH_GRACE_SECONDS

    interval = _cfg.get_heartbeat_interval("linux")  # the fake device is linux
    assert body["expires_in_seconds"] > interval
    assert body["expires_in_seconds"] == interval + TICKET_ATTACH_GRACE_SECONDS
    # Audited on grant.
    rows = db.query(AuditLog).filter(AuditLog.action == "terminal_session_opened").all()
    assert len(rows) == 1
    assert json.loads(rows[0].details_json)["device_id"] == 7


def test_unknown_device_404(monkeypatch):
    client = _client_only(monkeypatch, flag_on=True, capabilities={"terminal": ""})
    r = client.post("/devices/999/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 404


def test_403_scope_none_denies_everyone(monkeypatch):
    client = _client_only(monkeypatch, flag_on=True, capabilities={"terminal": ""}, scope="none", devices="7")
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 403


def test_403_scope_device_not_allowlisted(monkeypatch):
    client = _client_only(monkeypatch, flag_on=True, capabilities={"terminal": ""}, scope="device", devices="42")
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 403


def test_200_scope_device_allowlisted(monkeypatch):
    client = _client_only(monkeypatch, flag_on=True, capabilities={"terminal": ""}, scope="device", devices="7,42")
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 200


def test_200_scope_group_allowlisted(monkeypatch):
    client = _client_only(
        monkeypatch, flag_on=True, capabilities={"terminal": ""},
        scope="group", groups="5", device_group_id=5,
    )
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 200


def test_403_scope_group_not_allowlisted(monkeypatch):
    client = _client_only(
        monkeypatch, flag_on=True, capabilities={"terminal": ""},
        scope="group", groups="5", device_group_id=6,
    )
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 403


def test_200_scope_client_allowlisted(monkeypatch):
    client = _client_only(
        monkeypatch, flag_on=True, capabilities={"terminal": ""},
        scope="client", clients="100", device_client_id=100,
    )
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 200


def test_403_scope_client_not_allowlisted(monkeypatch):
    client = _client_only(
        monkeypatch, flag_on=True, capabilities={"terminal": ""},
        scope="client", clients="100", device_client_id=101,
    )
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 403


def test_200_scope_fleet_allows_any_device(monkeypatch):
    client = _client_only(monkeypatch, flag_on=True, capabilities={"terminal": ""}, scope="fleet")
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 200


def test_403_is_audited_with_denial_reason(monkeypatch):
    client, db = _client(monkeypatch, flag_on=True, capabilities={"terminal": ""}, scope="none")
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 403
    rows = db.query(AuditLog).filter(AuditLog.action == "terminal_session_denied").all()
    assert len(rows) == 1
    assert rows[0].entity_id == 7
    assert json.loads(rows[0].details_json)["reason"] == "outside_rollout_scope"
