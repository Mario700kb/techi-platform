"""Device status as real-time as the platform allows.

- A dead agent channel (power cut, cable, Wi-Fi) is found by uvicorn's
  protocol pings within 40 s; the application idle timeout is the backstop.
- A dropped channel is "reconnecting" at once (live false, live_lost_at set)
  and offline after a grace sized to how fast the agent reconnects: 90 s from
  2.1.27, 150 s for older agents whose backoff reaches 144 s.
- Every device response and realtime device event says whether the device is
  live; a live device is online whatever its last heartbeat, in counts too.
- The frontend ages rows itself with the same windows; the constants are
  pinned equal here.
"""
import json
import re
import time
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.auth import get_current_operator, get_operator_scope
from app.core.time import ensure_utc, utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.device import (
    EXPLICIT_OFFLINE_REASONS,
    ONLINE_WINDOW,
    STALE_WINDOW,
    Device,
    DeviceStatus,
    DeviceType,
    freshness_for,
)
from app.repositories.device_repository import DeviceRepository
from app.services import device_overview_service
from app.services.device_status_service import DeviceStatusService
from app.websocket import agent_channel_routes
from app.websocket.agent_channel import agent_command_channel
from app.websocket.events import device_payload, device_payload_delta, evict_ws_snapshot
from app.websocket.publisher import realtime_publisher

AGENT_ID = "agent_REALTIME_0123456789"
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def make(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    db.add_all([
        Device(id=924, agent_id=AGENT_ID, hostname="Mario-Lenovo", platform="windows", client_id=7,
               device_type=DeviceType.CLIENT, status=DeviceStatus.OFFLINE, agent_version="2.1.32",
               last_seen=utcnow() - timedelta(hours=3)),
        Device(id=925, agent_id="agent_other", hostname="Reception", platform="windows", client_id=7,
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, agent_version="2.1.20",
               last_seen=utcnow() - timedelta(minutes=1)),
    ])
    db.commit()
    db.close()
    monkeypatch.setattr(agent_channel_routes, "SessionLocal", factory)
    agent_command_channel.presence_paused = False
    device_overview_service.invalidate_overview_cache()
    yield factory
    agent_command_channel.presence_paused = False
    agent_command_channel._connections.clear()
    agent_command_channel._lost_at.clear()
    device_overview_service.invalidate_overview_cache()


@pytest.fixture()
def events(monkeypatch):
    published = []

    def publish_threadsafe(event, *, dedupe_key=None):
        published.append(event)

    monkeypatch.setattr(realtime_publisher, "publish_threadsafe", publish_threadsafe)
    return published


def _get(make, device_id=924):
    db = make()
    try:
        return DeviceRepository(db).get(device_id)
    finally:
        db.close()


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def _channel_app():
    app = FastAPI()
    app.include_router(agent_channel_routes.router)
    return app


def _device_events(events, device_id=924):
    return [e for e in events if (e.get("data") or {}).get("id") == device_id]


# ── loss detection timings ────────────────────────────────────────────── #

def _dockerfile_flag(name):
    text = (ROOT / "backend" / "Dockerfile").read_text()
    cmd = re.search(r"^CMD (\[.*\])$", text, re.MULTILINE).group(1)
    args = json.loads(cmd)
    return float(args[args.index(name) + 1])


def test_a_dead_channel_is_found_by_protocol_pings_within_45_seconds():
    """uvicorn pings every interval and closes a socket that does not answer
    within the timeout: a peer that died right after its last pong is found
    after interval + timeout."""
    interval = _dockerfile_flag("--ws-ping-interval")
    timeout = _dockerfile_flag("--ws-ping-timeout")
    assert interval + timeout <= 45
    # The implementation uvicorn picks ("auto") is one that sends them.
    from uvicorn.protocols.websockets.auto import AutoWebSocketsProtocol

    assert hasattr(AutoWebSocketsProtocol, "send_keepalive_ping") or "websockets_impl" in AutoWebSocketsProtocol.__module__


def test_the_idle_backstop_leaves_room_for_one_late_agent_ping():
    agent_ping, agent_write_deadline = 60, 10
    assert agent_ping + agent_write_deadline < agent_channel_routes.IDLE_TIMEOUT_SECONDS <= 90


@pytest.mark.parametrize("version,grace", [
    ("2.1.27", 90), ("2.1.32", 90), ("2.2.0", 90), ("3.0", 90),
    ("2.1.26", 150), ("2.1.23", 150), ("2.1.20", 150), (None, 150), ("", 150), ("garbage", 150),
])
def test_the_grace_follows_how_fast_the_agent_reconnects(version, grace):
    assert agent_channel_routes.presence_grace_seconds(version) == grace


def test_a_drop_during_a_self_update_waits_for_the_restart(make, events, monkeypatch):
    """The agent service stops for the package install: not offline after the
    usual 90 s, while the update is under way."""
    graces = []

    async def fake_grace(device_id, disconnected_at, grace_seconds=None):
        graces.append(grace_seconds)

    monkeypatch.setattr(agent_channel_routes, "_offline_after_grace", fake_grace)
    monkeypatch.setattr(agent_channel_routes, "_note_self_update_channel", lambda device_id, connected: True)
    url = f"/ws/agent/commands?device_id=924&agent_id={AGENT_ID}"
    with TestClient(_channel_app()) as client:
        with client.websocket_connect(url) as ws:
            assert _wait_for(lambda: agent_command_channel.is_connected(924))
            ws.close()
            # Within the session: TestClient runs each one on its own loop.
            assert _wait_for(lambda: graces == [agent_channel_routes.SELF_UPDATE_GRACE_SECONDS])


def test_the_short_grace_covers_the_reconnect_spread_and_the_dial():
    min_backoff, spread, dial_timeout = 5, 60, 20  # agent/command_channel.go
    assert agent_channel_routes.PRESENCE_GRACE_SECONDS >= min_backoff + spread + dial_timeout
    # The old agents' backoff tops out at 2 min + 20 %.
    assert agent_channel_routes.LEGACY_PRESENCE_GRACE_SECONDS >= 144


# ── live in responses ─────────────────────────────────────────────────── #

@pytest.fixture()
def api(make):
    from app.api.v1.endpoints.devices import router

    db = make()
    app = FastAPI()
    app.include_router(router, prefix="/api/v1/devices")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_operator_scope] = lambda: None
    app.dependency_overrides[get_current_operator] = lambda: None
    yield TestClient(app)
    db.close()


def test_list_and_detail_say_which_devices_are_live(api, make):
    agent_command_channel._connections[924] = object()
    listed = {d["id"]: d for d in api.get("/api/v1/devices/").json()["devices"]}
    assert (listed[924]["live"], listed[925]["live"]) == (True, False)
    assert listed[924]["live_lost_at"] is None
    detail = api.get("/api/v1/devices/924").json()
    assert detail["live"] is True
    assert "offline_reason" in detail


def test_a_live_device_is_online_whatever_its_last_heartbeat(api, make):
    """Its heartbeat 3 h old, but its channel open: online in the row, the
    filter and the counts alike (reconciliation already skips it)."""
    agent_command_channel._connections[924] = object()
    db = make()
    try:
        repo = DeviceRepository(db)
        assert repo.count_stats() == {"total": 2, "online": 2, "stale": 0, "offline": 0}
        assert {d.id: d.freshness_state for d in repo.directory()} == {924: "online", 925: "online"}
    finally:
        db.close()
    online = api.get("/api/v1/devices/", params={"freshness_state": "online"}).json()
    assert sorted(d["id"] for d in online["devices"]) == [924, 925]
    assert api.get("/api/v1/devices/quick-counts").json()["counts"]["online"] == 2

    agent_command_channel._connections.clear()
    db = make()
    try:
        assert DeviceRepository(db).count_stats()["offline"] == 1
    finally:
        db.close()


def test_known_offline_wins_over_an_open_channel():
    """A sleep event arrives a moment before the channel drops."""
    assert freshness_for(utcnow(), DeviceStatus.OFFLINE, "sleep", live=True) == "offline"
    assert freshness_for(utcnow() - timedelta(hours=1), DeviceStatus.ONLINE, None, live=True) == "online"


# ── realtime events ───────────────────────────────────────────────────── #

def test_connect_and_drop_each_publish_the_live_state_at_once(make, events, monkeypatch):
    monkeypatch.setattr(agent_channel_routes, "PRESENCE_GRACE_SECONDS", 3600)
    url = f"/ws/agent/commands?device_id=924&agent_id={AGENT_ID}"
    with TestClient(_channel_app()) as client:
        with client.websocket_connect(url) as ws:
            assert _wait_for(lambda: any(e["data"].get("live") for e in _device_events(events)))
            online = [e for e in _device_events(events) if e["type"] == "device_online"]
            assert online and online[0]["data"]["live"] is True
            assert online[0]["data"]["freshness_state"] == "online"
            ws.close()
            assert _wait_for(lambda: any(e["reason"] == "agent_channel_dropped" for e in events))
        dropped = [e for e in events if e["reason"] == "agent_channel_dropped"][0]["data"]
        # Before the grace decides: still online, no longer live, and when.
        assert dropped["live"] is False
        assert dropped["status"] == "online"
        assert dropped["live_lost_at"] is not None
        assert agent_command_channel.lost_since(924) is not None
        agent_channel_routes.cancel_presence_checks()
        assert _wait_for(lambda: agent_command_channel.lost_since(924) is None)


def test_a_device_already_online_still_hears_that_it_is_live(make, events, monkeypatch):
    monkeypatch.setattr(agent_channel_routes, "PRESENCE_GRACE_SECONDS", 3600)
    db = make()
    device = DeviceRepository(db).get(924)
    device.status = DeviceStatus.ONLINE
    device.last_seen = utcnow()
    db.commit()
    db.close()
    url = f"/ws/agent/commands?device_id=924&agent_id={AGENT_ID}"
    with TestClient(_channel_app()) as client:
        with client.websocket_connect(url):
            assert _wait_for(lambda: any(e["reason"] == "agent_channel_connected" for e in _device_events(events)))
        connected = [e for e in _device_events(events) if e["reason"] == "agent_channel_connected"]
        assert [e["type"] for e in connected] == ["device_updated"]
        assert connected[0]["data"]["live"] is True
        agent_channel_routes.cancel_presence_checks()


def test_a_channel_that_stays_down_is_offline_since_the_drop(make, events, monkeypatch):
    monkeypatch.setattr(agent_channel_routes, "PRESENCE_GRACE_SECONDS", 0)
    url = f"/ws/agent/commands?device_id=924&agent_id={AGENT_ID}"
    with TestClient(_channel_app()) as client:
        with client.websocket_connect(url) as ws:
            assert _wait_for(lambda: _get(make).status == DeviceStatus.ONLINE)
            before_drop = utcnow()
            ws.close()
            # Within the session: TestClient runs each one on its own loop.
            assert _wait_for(lambda: _get(make).status == DeviceStatus.OFFLINE)
    device = _get(make)
    assert device.offline_reason == "connection_lost"
    assert device.freshness_state == "offline"
    # Offline since the drop, not since the last heartbeat.
    assert ensure_utc(device.last_seen) >= before_drop - timedelta(seconds=1)
    offline = [e for e in _device_events(events) if e["type"] == "device_offline"][-1]["data"]
    assert (offline["live"], offline["live_lost_at"], offline["offline_reason"]) == (False, None, "connection_lost")


def test_a_heartbeat_during_the_grace_keeps_it_online_and_ends_reconnecting(make, events):
    db = make()
    device = DeviceRepository(db).get(924)
    DeviceStatusService(db).mark_online_from_channel(device)
    db.close()
    dropped_at = utcnow() - timedelta(seconds=30)
    agent_command_channel.note_lost(924, dropped_at)
    db = make()
    device = DeviceRepository(db).get(924)
    device.last_seen = utcnow()  # the heartbeat after the drop
    db.commit()
    db.close()
    events.clear()

    import asyncio

    asyncio.run(agent_channel_routes._offline_after_grace(924, dropped_at, 0))
    assert _get(make).status == DeviceStatus.ONLINE
    assert agent_command_channel.lost_since(924) is None
    ended = [e for e in events if e["reason"] == "agent_channel_grace_ended"]
    assert ended and ended[0]["data"]["live_lost_at"] is None and ended[0]["data"]["status"] == "online"


def test_an_earlier_drops_check_leaves_a_later_drop_to_its_own_grace(make, events, monkeypatch):
    import asyncio

    marked = []
    monkeypatch.setattr(agent_channel_routes, "_mark_lost", lambda *a: marked.append(a))
    first, second = utcnow() - timedelta(seconds=60), utcnow()
    agent_command_channel.note_lost(924, second)  # reconnected, then dropped again
    asyncio.run(agent_channel_routes._offline_after_grace(924, first, 0))
    assert marked == []
    assert agent_command_channel.lost_since(924) == second


def test_a_power_event_reads_offline_since_the_event(make, events):
    db = make()
    device = DeviceRepository(db).get(925)
    DeviceStatusService(db).mark_offline_from_power_event(device, "shutdown")
    db.refresh(device)
    assert ensure_utc(device.last_seen) >= utcnow() - timedelta(seconds=5)
    assert device.freshness_state == "offline"
    db.close()


def test_every_device_event_carries_presence(make):
    db = make()
    device = DeviceRepository(db).get(925)
    payload = device_payload(device)
    db.close()
    assert {"live", "live_lost_at", "offline_reason", "status", "last_seen", "freshness_state"} <= set(payload)


def test_a_heartbeat_delta_keeps_the_fields_the_scope_filter_needs():
    """Operators limited to some clients get events by client_id/group_id; a
    delta without them was dropped, so their rows never saw a heartbeat."""
    evict_ws_snapshot(4242)
    first = {"id": 4242, "client_id": 7, "group_id": 3, "last_seen": "a", "status": "online"}
    device_payload_delta(first)
    delta = device_payload_delta({**first, "last_seen": "b"})
    assert delta == {"id": 4242, "client_id": 7, "group_id": 3, "last_seen": "b"}
    evict_ws_snapshot(4242)


# ── counts follow the rows ────────────────────────────────────────────── #

def test_the_overview_says_when_a_count_next_changes_by_time(make):
    db = make()
    try:
        overview = device_overview_service.DeviceOverviewService(db)._compute_overview(None)
        seen = ensure_utc(DeviceRepository(db).get(925).last_seen)
        # 925 is online (1 min); 924 is long offline and never moves by time.
        assert abs((overview.next_change_at - (seen + ONLINE_WINDOW)).total_seconds()) < 1
    finally:
        db.close()


def test_a_status_change_makes_the_overview_count_again(make, monkeypatch):
    cache = device_overview_service._overview_cache
    monkeypatch.setattr(cache, "min_age_after_change", 0.0)
    db = make()
    try:
        service = device_overview_service.DeviceOverviewService(db)
        assert service.get_overview().stats.online == 1
        device = DeviceRepository(db).get(924)
        device.status = DeviceStatus.ONLINE
        device.last_seen = utcnow()
        db.commit()
        assert service.get_overview().stats.online == 1  # cached, nothing said
        device_overview_service.note_fleet_change()
        assert service.get_overview().stats.online == 2
    finally:
        db.close()


def test_the_overview_counts_again_once_a_device_crossed_a_window(make, monkeypatch):
    cache = device_overview_service._overview_cache
    monkeypatch.setattr(cache, "min_age_after_change", 0.0)
    db = make()
    try:
        service = device_overview_service.DeviceOverviewService(db)
        first = service.get_overview()
        assert first.stats.online == 1
        device = DeviceRepository(db).get(925)
        device.last_seen = utcnow() - ONLINE_WINDOW - timedelta(seconds=1)  # as if time passed
        db.commit()
        monkeypatch.setattr(device_overview_service, "utcnow", lambda: first.next_change_at + timedelta(seconds=1))
        assert service.get_overview().stats.stale == 1
    finally:
        db.close()


# ── the frontend mirrors the rules ────────────────────────────────────── #

def test_the_frontend_ages_rows_with_the_same_windows_and_reasons():
    text = (ROOT / "frontend" / "src" / "utils" / "devicePresence.ts").read_text()
    online = int(re.search(r"export const ONLINE_WINDOW_MINUTES = (\d+);", text).group(1))
    stale = int(re.search(r"export const STALE_WINDOW_MINUTES = (\d+);", text).group(1))
    reasons = re.search(r"export const EXPLICIT_OFFLINE_REASONS = \[([^\]]*)\]", text).group(1)
    assert timedelta(minutes=online) == ONLINE_WINDOW
    assert timedelta(minutes=stale) == STALE_WINDOW
    assert tuple(re.findall(r'"([a-z_]+)"', reasons)) == EXPLICIT_OFFLINE_REASONS
