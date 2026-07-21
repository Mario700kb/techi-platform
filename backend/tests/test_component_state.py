"""Desired-State foundation: per-device component Installed/Desired/Health/Status.

Read-only resolution — no writes, no migration, no enforcement. Uses an in-memory
SQLite device + a fake AgentPackageService so version resolution is deterministic.
"""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import devices as devices_endpoint
from app.core.auth import get_current_operator, get_operator_scope
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.platform_core.components import ComponentHealth
from app.services import component_state_service as css


class _FakePackages:
    """Stand-in for AgentPackageService.latest_active keyed by (platform, file_type)."""

    def __init__(self, active):
        self._active = active

    def latest_active(self, platform, *, file_type=None):
        version = self._active.get((platform, file_type))
        return SimpleNamespace(version=version) if version else None


def _service(monkeypatch, db, active):
    svc = css.ComponentStateService(db)
    svc._packages = _FakePackages(active)
    return svc


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _add_device(db, **kwargs):
    defaults = dict(id=1, hostname="pc1", device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE)
    defaults.update(kwargs)
    device = Device(**defaults)
    db.add(device)
    db.commit()
    return device


def test_windows_agent_outdated_rs_current(monkeypatch, db):
    device = _add_device(db, platform="windows", agent_version="2.1.5", rustdesk_version="1.4.8")
    active = {
        ("windows-amd64", "agent_binary"): "2.1.14",
        ("windows-amd64", "remote_support_msi"): "1.4.8",
    }
    states = {s.component_id: s for s in _service(monkeypatch, db, active).resolve_for_device(device)}
    assert set(states) == {"agent", "remote_support"}
    assert states["agent"].installed_version == "2.1.5"
    assert states["agent"].desired_version == "2.1.14"
    assert states["agent"].health == ComponentHealth.OUTDATED
    assert states["agent"].status == "Outdated"
    assert states["remote_support"].health == ComponentHealth.CURRENT
    assert states["remote_support"].status == "Current"


def test_agent_binary_preferred_over_msi(monkeypatch, db):
    device = _add_device(db, platform="windows", agent_version="2.1.14")
    active = {
        ("windows-amd64", "agent_binary"): "2.1.14",
        ("windows-amd64", "msi"): "2.0.0",  # must NOT be chosen as desired
    }
    agent = {s.component_id: s for s in _service(monkeypatch, db, active).resolve_for_device(device)}["agent"]
    assert agent.desired_version == "2.1.14"
    assert agent.health == ComponentHealth.CURRENT


def test_remote_support_missing_when_not_installed(monkeypatch, db):
    device = _add_device(db, platform="windows", agent_version="2.1.14", rustdesk_version=None)
    active = {
        ("windows-amd64", "agent_binary"): "2.1.14",
        ("windows-amd64", "remote_support_msi"): "1.4.8",
    }
    rs = {s.component_id: s for s in _service(monkeypatch, db, active).resolve_for_device(device)}["remote_support"]
    assert rs.installed_version is None
    assert rs.desired_version == "1.4.8"
    assert rs.health == ComponentHealth.MISSING
    assert rs.status == "Missing"


def test_unknown_when_no_active_desired(monkeypatch, db):
    device = _add_device(db, platform="windows", agent_version="2.1.14")
    states = {s.component_id: s for s in _service(monkeypatch, db, {}).resolve_for_device(device)}
    assert states["agent"].desired_version is None
    assert states["agent"].health == ComponentHealth.UNKNOWN
    assert states["agent"].status == "Unknown"


def test_linux_has_agent_only(monkeypatch, db):
    device = _add_device(db, platform="linux", agent_version="2.1.14")
    active = {("linux-amd64", "agent_binary"): "2.1.14"}
    states = [s.component_id for s in _service(monkeypatch, db, active).resolve_for_device(device)]
    assert states == ["agent"]  # no Remote Support package file_type on Linux


def test_darwin_has_remote_support_only(monkeypatch, db):
    device = _add_device(db, platform="darwin", rustdesk_version="1.4.8")
    active = {("darwin-arm64", "remote_support_pkg"): "1.4.8"}
    states = {s.component_id: s for s in _service(monkeypatch, db, active).resolve_for_device(device)}
    assert set(states) == {"remote_support"}
    assert states["remote_support"].desired_version == "1.4.8"
    assert states["remote_support"].health == ComponentHealth.CURRENT


def test_connector_platform_has_no_components(monkeypatch, db):
    device = _add_device(db, platform="mikrotik", agent_version=None)
    assert _service(monkeypatch, db, {}).resolve_for_device(device) == []


# --------------------------- endpoint ----------------------------------- #
def _client(db, device):
    app = FastAPI()
    app.include_router(devices_endpoint.router, prefix="/devices")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=1, username="m", role="operator")
    app.dependency_overrides[get_operator_scope] = lambda: None
    return TestClient(app)


def test_endpoint_returns_states(monkeypatch, db):
    device = _add_device(db, platform="windows", agent_version="2.1.5", rustdesk_version="1.4.8")
    # Patch AgentPackageService used inside the service to deterministic versions.
    monkeypatch.setattr(
        css, "AgentPackageService",
        lambda: _FakePackages({
            ("windows-amd64", "agent_binary"): "2.1.14",
            ("windows-amd64", "remote_support_msi"): "1.4.8",
        }),
    )
    resp = _client(db, device).get(f"/devices/{device.id}/component-states")
    assert resp.status_code == 200
    body = resp.json()
    assert body["schema_version"] == 1
    assert body["device_id"] == device.id
    by_id = {c["component_id"]: c for c in body["components"]}
    assert by_id["agent"]["status"] == "Outdated"
    assert by_id["agent"]["health"] == "outdated"
    assert by_id["remote_support"]["status"] == "Current"
