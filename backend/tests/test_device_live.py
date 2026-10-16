"""Live device view: an open device page asks the agent, over its command
channel, to stream snapshots; the frames go to the page and nowhere else.

The end-to-end tests run the real UI and agent WebSocket routes against a
SQLite database: the page connects to /ws/devices/{id}/live, the "agent" to
/ws/agent/commands, and the frames have to travel between them.
"""
import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.websockets import WebSocketDisconnect

import app.models  # noqa: F401
from app.core.security import create_access_token
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import Operator
from app.models.team import Team, TeamClientAccess, TeamMember
from app.websocket import agent_channel_routes, live_hub
from app.websocket import routes as ws_routes
from app.websocket.live_hub import DeviceLiveHub, parse_agent_message

AGENT_ID = "agent_LIVE_9f8e7d6c5b4a3"

FRAME = {
    "at": 1760655600000,
    "cpu_percent": 37.5,
    "ram_percent": 61.2,
    "ram_used_mb": 9800.0,
    "ram_total_mb": 16000.0,
    "disks": [{"mount": "C:", "used_percent": 71.0, "free_gb": 68.4, "total_gb": 237.9}],
    "net_rx_kbps": 820.4,
    "net_tx_kbps": 95.1,
    "uptime_seconds": 86400,
    "current_user": "TECHI\\mario",
    "user_session_state": "active",
    "process_count": 212,
    "processes": [{"pid": 4321, "name": "sqlservr.exe", "cpu_percent": 22.0, "memory_mb": 4100.0}],
}


class _FakeWS:
    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


# ── hub ──────────────────────────────────────────────────────────────────── #

def test_a_frame_nobody_watches_is_dropped():
    hub = DeviceLiveHub()
    assert asyncio.run(hub.publish(924, FRAME)) == 0


def test_a_frame_reaches_every_viewer_of_that_device_only():
    hub = DeviceLiveHub()
    a, b, other = _FakeWS(), _FakeWS(), _FakeWS()

    async def scenario():
        await hub.add_viewer(924, a)
        await hub.add_viewer(924, b)
        await hub.add_viewer(925, other)
        return await hub.publish(924, {**FRAME, "smuggled": "<script>"})

    assert asyncio.run(scenario()) == 2
    assert a.sent == b.sent and len(a.sent) == 1
    assert other.sent == []
    message = a.sent[0]
    assert message["type"] == "live" and message["device_id"] == 924
    assert message["data"]["cpu_percent"] == 37.5
    assert "smuggled" not in message["data"]


def test_frames_faster_than_one_a_second_are_dropped():
    hub = DeviceLiveHub()
    viewer = _FakeWS()

    async def scenario():
        await hub.add_viewer(924, viewer)
        return [await hub.publish(924, FRAME) for _ in range(5)]

    assert asyncio.run(scenario()) == [1, 0, 0, 0, 0]


@pytest.mark.parametrize(
    "bad",
    [
        {"cpu_percent": 500},
        {"processes": [{"pid": 1, "name": "x", "cpu_percent": 1, "memory_mb": 1}] * 16},
        {"current_user": "u" * 300},
        "not an object",
    ],
)
def test_a_malformed_frame_is_dropped(bad):
    hub = DeviceLiveHub()
    viewer = _FakeWS()

    async def scenario():
        await hub.add_viewer(924, viewer)
        return await hub.publish(924, bad)

    assert asyncio.run(scenario()) == 0
    assert viewer.sent == []


def test_only_the_last_viewer_leaving_ends_the_view():
    hub = DeviceLiveHub()
    a, b = _FakeWS(), _FakeWS()

    async def scenario():
        await hub.add_viewer(924, a)
        await hub.add_viewer(924, b)
        return await hub.remove_viewer(924, a), await hub.remove_viewer(924, b)

    assert asyncio.run(scenario()) == (False, True)
    assert hub.has_viewers(924) is False


def test_agent_messages_must_be_small_json_objects():
    assert parse_agent_message('{"type":"ping"}') == {"type": "ping"}
    assert parse_agent_message("[1,2]") is None
    assert parse_agent_message("not json") is None
    assert parse_agent_message('{"type":"live","data":"' + "x" * 20000 + '"}') is None


# ── end to end ───────────────────────────────────────────────────────────── #

@pytest.fixture()
def world(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    home = Client(name="Techi", slug="techi")
    elsewhere = Client(name="Other", slug="other")
    db.add_all([home, elsewhere])
    db.flush()
    db.add_all([
        Operator(id=1, username="owner", email="o@example.com", hashed_password="x", role="owner", is_active=True),
        Operator(id=2, username="tech", email="t@example.com", hashed_password="x", role="operator", is_active=True),
    ])
    db.add_all([
        Device(id=924, agent_id=AGENT_ID, hostname="Mario-Lenovo", platform="windows",
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, client_id=home.id),
        Device(id=925, agent_id="agent_other", hostname="Elsewhere", platform="windows",
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, client_id=elsewhere.id),
    ])
    team = Team(name="Support")
    db.add(team)
    db.flush()
    db.add_all([TeamMember(team_id=team.id, operator_id=2), TeamClientAccess(team_id=team.id, client_id=home.id)])
    db.commit()
    db.close()
    monkeypatch.setattr(ws_routes, "SessionLocal", factory)
    monkeypatch.setattr(agent_channel_routes, "SessionLocal", factory)
    monkeypatch.setattr(live_hub, "device_live_hub", DeviceLiveHub())
    monkeypatch.setattr(agent_channel_routes, "device_live_hub", live_hub.device_live_hub)
    app = FastAPI()
    app.include_router(ws_routes.router)
    app.include_router(agent_channel_routes.router)
    return TestClient(app)


def _page(client, device_id, operator_id="1"):
    token = create_access_token(operator_id)
    return client.websocket_connect(
        f"/ws/devices/{device_id}/live", subprotocols=["techi.v1", f"techi.auth.{token}"]
    )


def _agent(client):
    return client.websocket_connect(f"/ws/agent/commands?device_id=924&agent_id={AGENT_ID}")


def test_an_open_page_starts_the_agent_streaming_and_receives_its_frames(world):
    with _agent(world) as agent:
        with _page(world, 924) as page:
            assert page.receive_json() == {"type": "live_status", "agent_connected": True, "interval_seconds": 3}
            assert agent.receive_json() == {"type": "live_start", "interval_seconds": 3, "ttl_seconds": 45}

            agent.send_json({"type": "live", "data": FRAME})
            frame = page.receive_json()
            assert frame["type"] == "live" and frame["device_id"] == 924
            assert frame["data"]["processes"][0]["name"] == "sqlservr.exe"

        # The page closed and nobody else watches: the agent is told to stop.
        assert agent.receive_json() == {"type": "live_stop"}


def test_a_page_says_when_the_agent_is_not_connected(world):
    with _page(world, 924) as page:
        assert page.receive_json()["agent_connected"] is False


def test_an_agent_connecting_while_the_page_is_open_starts_at_once(world):
    with _page(world, 924) as page:
        assert page.receive_json()["agent_connected"] is False
        with _agent(world) as agent:
            assert agent.receive_json()["type"] == "live_start"


def test_an_operator_cannot_watch_a_device_outside_their_teams(world):
    with _page(world, 924, operator_id="2") as page:
        assert page.receive_json()["type"] == "live_status"
    with pytest.raises(WebSocketDisconnect) as closed:
        with _page(world, 925, operator_id="2") as page:
            page.receive_json()
    assert closed.value.code == 4001


def test_an_unauthenticated_page_is_refused(world):
    with pytest.raises(WebSocketDisconnect) as closed:
        with world.websocket_connect("/ws/devices/924/live", subprotocols=["techi.v1"]) as page:
            page.receive_json()
    assert closed.value.code == 4001


# ── single-device actions are pushed at once ─────────────────────────────── #

def test_a_single_device_action_is_pushed_over_the_channel(monkeypatch):
    from app.api.v1.endpoints import actions as actions_endpoint
    from app.core.auth import get_current_operator
    from app.db.session import get_db

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    owner = Operator(id=1, username="owner", email="o@example.com", hashed_password="x", role="owner", is_active=True)
    db.add_all([owner, Device(id=924, agent_id=AGENT_ID, hostname="Mario-Lenovo", platform="windows",
                              device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE)])
    db.commit()

    pushed = []
    monkeypatch.setattr(
        actions_endpoint, "push_action_if_connected",
        lambda device_id, action, svc: pushed.append((device_id, action.action_type)) or True,
    )
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: owner
    app.include_router(actions_endpoint.router)

    response = TestClient(app).post("/devices/924/actions", json={"action_type": "refresh_inventory"})

    assert response.status_code == 200, response.text
    assert [(d, str(getattr(t, "value", t))) for d, t in pushed] == [(924, "refresh_inventory")]


def test_every_status_step_of_a_fast_action_reaches_the_page(monkeypatch):
    """Over the channel an action goes sent → acknowledged → completed within a
    second. Each step must be published; one dedupe key per action dropped
    everything after "sent" and the page stayed on "Sent"."""
    from app.services import remote_action_service as ras
    from app.websocket.publisher import RealtimeEventPublisher

    publisher = RealtimeEventPublisher()
    kept = []

    def publish_threadsafe(event, *, dedupe_key=None):
        if not publisher._is_duplicate(dedupe_key):
            kept.append(event["data"]["status"])

    monkeypatch.setattr(ras.realtime_publisher, "publish_threadsafe", publish_threadsafe)

    class _Action:
        id = 2581
        device_id = 924

    action = _Action()
    for status in ("sent", "acknowledged", "running", "completed", "completed"):
        action.status = status
        monkeypatch.setattr(ras, "_action_event_payload", lambda a: {"id": a.id, "status": a.status})
        ras._publish_action_status(action, ras.RealtimeEventType.ACTION_STATUS_CHANGED)

    assert kept == ["sent", "acknowledged", "running", "completed"]


def test_the_page_can_ask_whether_the_agent_channel_is_open(monkeypatch):
    from app.api.v1.endpoints import actions as actions_endpoint
    from app.core.auth import get_current_operator
    from app.db.session import get_db
    from app.websocket.agent_channel import agent_command_channel

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    owner = Operator(id=1, username="owner", email="o@example.com", hashed_password="x", role="owner", is_active=True)
    db.add_all([owner, Device(id=924, agent_id=AGENT_ID, hostname="Mario-Lenovo", platform="windows",
                              device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE)])
    db.commit()
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: owner
    app.include_router(actions_endpoint.router)
    client = TestClient(app)

    monkeypatch.setattr(agent_command_channel, "is_connected", lambda device_id: device_id == 924)
    assert client.get("/devices/924/agent-channel").json() == {"connected": True}
    assert client.get("/devices/999/agent-channel").status_code == 404
