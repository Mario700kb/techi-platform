"""Updating the agent on a selection of devices (Devices page bulk bar): the
selection is planned — devices already current, busy with another update or
without an agent to update are left out with their reason — then queued,
announced and pushed over the live channel where the agent holds one."""
from types import SimpleNamespace

from datetime import datetime
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import agent_commands as endpoint
from app.core.auth import get_current_operator
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus
from app.models.remote_action import ActionStatus, RemoteAction
from app.schemas.agent_command import BulkCommandCreate, BulkCommandTarget
from app.services import action_push
from app.services import agent_command_service as module
from app.services.agent_command_service import AgentCommandService

SHA = "a" * 64
LINUX_SHA = "d" * 64


class FakePackages:
    def latest_active(self, platform, *, file_type=None):
        if platform == "windows-amd64" and file_type == "agent_binary":
            return SimpleNamespace(version="2.1.33", sha256=SHA)
        if platform == "windows-amd64" and file_type == "agent_update_msi":
            return SimpleNamespace(version="2.1.33.0", sha256="c" * 64)
        if platform == "linux-amd64":
            return SimpleNamespace(version="2.1.33", sha256=LINUX_SHA)
        return None

    def agent_binary_download_url(self):
        return "/api/v1/agent-packages/agent-binary/download"

    def agent_update_msi_download_url(self):
        return "/api/v1/agent-packages/agent-update-msi/download"


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    monkeypatch.setattr(module, "AgentPackageService", FakePackages)
    session.add_all([
        Device(id=1, hostname="Mario-Lenovo", agent_id="a1", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.32", agent_sha256="b" * 64),
        Device(id=2, hostname="HV-PROD-01", agent_id="a2", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.33", agent_sha256=SHA),
        Device(id=3, hostname="Reception", agent_id="a3", platform="windows", status=DeviceStatus.OFFLINE,
               agent_version="2.1.20"),
        Device(id=4, hostname="Busy-PC", agent_id="a4", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.31"),
        Device(id=5, hostname="core-router", agent_id="a5", platform="mikrotik", status=DeviceStatus.ONLINE),
        Device(id=6, hostname="web-01", agent_id="a6", platform="linux", architecture="x86_64",
               status=DeviceStatus.ONLINE, agent_version="2.1.23"),
        Device(id=7, hostname="Old-PC", agent_id="a7", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.20", is_archived=True, archived_at=datetime(2026, 1, 1)),
    ])
    session.add(RemoteAction(device_id=4, action_type="restart_agent", status=ActionStatus.QUEUED, payload="{}",
                             created_by="denis"))
    session.commit()
    yield session
    session.close()


def _bulk(db, ids):
    return AgentCommandService(db).create_bulk(
        BulkCommandCreate(command_type="self_update", target=BulkCommandTarget.DEVICES, device_ids=ids),
        operator_username="denis",
    )


def test_a_selection_updates_only_what_needs_it_and_says_why_for_the_rest(db, monkeypatch):
    pushed_to = []
    monkeypatch.setattr(action_push, "push_action_if_connected",
                        lambda device_id, action, svc: pushed_to.append(device_id) or device_id == 1)

    result = _bulk(db, [1, 2, 3, 4, 5, 6, 7, 99])

    queued = {a.device_id: a for a in db.query(RemoteAction).filter(RemoteAction.batch_id == result.batch_id)}
    assert sorted(queued) == [1, 3, 6]
    assert result.device_count == 3
    assert {s.name: s.reason for s in result.skipped} == {
        "HV-PROD-01": "Already on 2.1.33",
        "Busy-PC": "Restart agent already queued (#1)",
        "core-router": "No TECHI agent to update on this platform",
        "#7": "Archived or not found",
        "#99": "Archived or not found",
    }
    # Each device gets the package for its own platform.
    assert '"download_url": "' in queued[1].payload and "agent-binary/download" in queued[1].payload
    assert "platform/linux-amd64/download" in queued[6].payload
    # Every action is offered to the live channel; Mario-Lenovo's agent holds one.
    assert sorted(pushed_to) == [1, 3, 6] and result.pushed == 1


def test_a_second_update_of_the_same_devices_skips_them_as_busy(db, monkeypatch):
    monkeypatch.setattr(action_push, "push_action_if_connected", lambda *a: False)
    first = _bulk(db, [1, 3])
    assert first.device_count == 2
    with pytest.raises(ValueError, match="Nothing to update: Update already queued"):
        _bulk(db, [1, 3])


def test_nothing_to_update_creates_nothing(db):
    with pytest.raises(ValueError, match="Nothing to update: Already on 2.1.33"):
        _bulk(db, [2])
    assert db.query(RemoteAction).filter(RemoteAction.action_type == "self_update").count() == 0


def test_the_preview_lists_who_updates_from_which_version_and_who_is_skipped(db, monkeypatch):
    from app.websocket.agent_channel import agent_command_channel

    monkeypatch.setattr(agent_command_channel, "is_connected", lambda device_id: device_id == 1)
    preview = AgentCommandService(db).preview_self_update([1, 2, 3, 6])
    assert preview.version == "2.1.33"
    assert [(i.name, i.from_version, i.to_version, i.live) for i in preview.update] == [
        ("Mario-Lenovo", "2.1.32", "2.1.33", True),
        ("Reception", "2.1.20", "2.1.33", False),
        ("web-01", "2.1.23", "2.1.33", False),
    ]
    assert [(s.name, s.reason) for s in preview.skipped] == [("HV-PROD-01", "Already on 2.1.33")]
    assert db.query(RemoteAction).filter(RemoteAction.action_type == "self_update").count() == 0


def test_the_preview_is_for_admins_and_owners(db):
    app = FastAPI()
    app.include_router(endpoint.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: db
    role = {"value": "operator"}
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(
        id=1, username="x", role=role["value"], is_active=True)
    client = TestClient(app)
    assert client.post("/api/v1/commands/bulk/self-update/preview", json={"device_ids": [1]}).status_code == 403
    role["value"] = "admin"
    response = client.post("/api/v1/commands/bulk/self-update/preview", json={"device_ids": [1]})
    assert response.status_code == 200, response.text
    assert response.json()["update"][0]["to_version"] == "2.1.33"
    assert client.post("/api/v1/commands/bulk/self-update/preview", json={"device_ids": []}).status_code == 422


def test_the_devices_page_request_is_accepted_and_runs_for_15_minutes(db, monkeypatch):
    """The exact body the bulk bar sends (DevicesTable runAgentUpdate)."""
    monkeypatch.setattr(action_push, "push_action_if_connected", lambda *a: False)
    app = FastAPI()
    app.include_router(endpoint.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(
        id=1, username="denis", role="owner", is_active=True)
    body = {"command_type": "self_update", "target": "devices", "device_ids": [1, 3], "payload": {}, "timeout_seconds": 600}
    response = TestClient(app).post("/api/v1/commands/bulk", json=body)
    assert response.status_code == 201, response.text
    assert response.json()["device_count"] == 2
    actions = db.query(RemoteAction).filter(RemoteAction.action_type == "self_update").all()
    assert {a.execution_timeout_seconds for a in actions} == {900}
