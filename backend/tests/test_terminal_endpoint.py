"""Phase 5 M2 — Web Terminal session endpoint (flag-gated)."""

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
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import OperatorRole


def _client(monkeypatch, flag_on: bool, capabilities=None):
    # FEATURE_TERMINAL depends on CORE+LINUX+VAULT (fail-closed dependency chain).
    for flag in ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT", "FEATURE_TERMINAL"):
        monkeypatch.setattr(settings, flag, flag_on)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(id=7, hostname="lin-1", platform="linux", capabilities=capabilities,
                  device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE))
    db.commit()
    app = FastAPI()
    app.include_router(terminal_endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=OperatorRole.ADMIN.value)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app)


def test_404_when_flag_off(monkeypatch):
    client = _client(monkeypatch, flag_on=False, capabilities={"terminal": ""})
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 404


def test_400_when_device_lacks_terminal_capability(monkeypatch):
    client = _client(monkeypatch, flag_on=True, capabilities={"docker": "26.1"})
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 400


def test_creates_session_and_returns_ws_path(monkeypatch):
    client = _client(monkeypatch, flag_on=True, capabilities={"terminal": "", "bash": ""})
    r = client.post("/devices/7/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["session_id"]
    assert body["operator_ws_path"].startswith("wss://")
    assert f"/ws/terminal/{body['session_id']}" in body["operator_ws_path"]
    assert body["operator_ticket"] in body["operator_ws_path"]
    assert body["expires_in_seconds"] == 60


def test_unknown_device_404(monkeypatch):
    client = _client(monkeypatch, flag_on=True, capabilities={"terminal": ""})
    r = client.post("/devices/999/terminal/sessions", json={"engine": "bash"})
    assert r.status_code == 404
