"""An agent is known by its agent_id, not by the device_id in its config.

2026-10-19: Mario-Lenovo (device 924) was deleted for good and let back in;
its agent's next heartbeat, resolved by agent_id, re-created it as 983 and it
showed online. But the agent kept device_id 924 in its config, so its command
channel was refused on every attempt (unknown device): no live state, no
instant actions. Five more agents were in the same state after older deletes.
"""
import time
from datetime import timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import agent as agent_endpoints
from app.api.v1.endpoints.agent import router as agent_router
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.services.agent_identity import resolve_agent_device
from app.websocket import agent_channel_routes
from app.websocket.agent_channel import agent_command_channel

AGENT_ID = "agent_MARIO_0123456789abcdef"
STALE_ID = 924
REAL_ID = 983


@pytest.fixture()
def make(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    db.add(Device(id=REAL_ID, agent_id=AGENT_ID, hostname="Mario-Lenovo", platform="windows",
                  device_type=DeviceType.CLIENT, status=DeviceStatus.OFFLINE,
                  last_seen=utcnow() - timedelta(hours=3)))
    db.commit()
    db.close()
    monkeypatch.setattr(agent_channel_routes, "SessionLocal", factory)
    monkeypatch.setattr(agent_endpoints, "SessionLocal", factory)
    agent_command_channel.presence_paused = False
    yield factory


def _device(make):
    db = make()
    try:
        return db.get(Device, REAL_ID)
    finally:
        db.close()


def test_resolution_prefers_the_named_device_and_falls_back_to_the_agent_id(make):
    db = make()
    assert resolve_agent_device(db, REAL_ID, AGENT_ID).id == REAL_ID
    assert resolve_agent_device(db, STALE_ID, AGENT_ID).id == REAL_ID
    assert resolve_agent_device(db, STALE_ID, "agent_someone_else") is None
    assert resolve_agent_device(db, REAL_ID, "") is None


def test_a_stale_device_id_still_opens_the_live_channel_of_the_real_device(make):
    app = FastAPI()
    app.include_router(agent_channel_routes.router)
    with TestClient(app).websocket_connect(f"/ws/agent/commands?device_id={STALE_ID}&agent_id={AGENT_ID}"):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and _device(make).status != DeviceStatus.ONLINE:
            time.sleep(0.02)
        assert agent_command_channel.is_connected(REAL_ID)
        assert not agent_command_channel.is_connected(STALE_ID)
        assert _device(make).status == DeviceStatus.ONLINE


def test_an_unknown_agent_is_still_refused(make):
    from starlette.websockets import WebSocketDisconnect

    app = FastAPI()
    app.include_router(agent_channel_routes.router)
    with pytest.raises(WebSocketDisconnect) as exc:
        with TestClient(app).websocket_connect(f"/ws/agent/commands?device_id={REAL_ID}&agent_id=agent_wrong") as ws:
            ws.receive_text()
    assert exc.value.code == 4001


@pytest.fixture()
def client(make):
    app = FastAPI()

    def get():
        db = make()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = get
    app.include_router(agent_router, prefix="/api/v1/agent")
    return TestClient(app)


def test_power_event_and_telemetry_accept_a_stale_device_id(client, make):
    response = client.post("/api/v1/agent/power-event",
                           json={"device_id": STALE_ID, "agent_id": AGENT_ID, "state": "shutdown"})
    assert response.status_code == 204

    with patch("app.api.v1.endpoints.agent.TelemetryIngestService") as ingest:
        ingest.return_value.ingest.return_value = {"ack_seq": 0, "stored": 0, "duplicates": 0, "rejected": 0,
                                                   "policy_version": "1.1", "next_upload_seconds": 900}
        response = client.post("/api/v1/agent/telemetry", json={"device_id": STALE_ID, "agent_id": AGENT_ID})
    assert response.status_code == 200
    assert ingest.return_value.ingest.call_args.args[0].id == REAL_ID

    refused = client.post("/api/v1/agent/power-event",
                          json={"device_id": REAL_ID, "agent_id": "agent_wrong", "state": "sleep"})
    assert refused.status_code == 403


def test_the_status_panel_names_agents_online_without_their_channel(make):
    from app.services import system_status_service as sss

    db = make()
    old = utcnow() - timedelta(hours=2)
    db.add_all([
        Device(id=1, agent_id="a1", hostname="ws", platform="windows", device_type=DeviceType.CLIENT,
               status=DeviceStatus.ONLINE, last_seen=utcnow(), agent_version="2.1.33", registered_at=old),
        Device(id=2, agent_id="a2", hostname="old", platform="windows", device_type=DeviceType.CLIENT,
               status=DeviceStatus.ONLINE, last_seen=utcnow(), agent_version="2.1.20", registered_at=old),
        Device(id=3, agent_id="a3", hostname="new", platform="windows", device_type=DeviceType.CLIENT,
               status=DeviceStatus.ONLINE, last_seen=utcnow(), agent_version="2.1.33", registered_at=utcnow()),
    ])
    db.commit()
    with patch.object(agent_command_channel, "connected_ids", return_value=[]):
        assert sss.devices_missing_channel(db, utcnow()) == [1]  # 2 has no channel, 3 just enrolled
    with patch.object(agent_command_channel, "connected_ids", return_value=[1]):
        assert sss.devices_missing_channel(db, utcnow()) == []
