"""Online/offline from the agent's live channel.

The open channel says the agent is up: online at once. A channel that drops
and does not come back within the grace period means offline at once, with
reason connection_lost, everywhere (lists, filters and counts use the same
rule). A heartbeat after the drop, a reconnect, or a backend shutdown never
marks a device offline.
"""
import asyncio
import time
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow
from app.db.base import Base
from app.models.device import Device, DeviceFreshnessState, DeviceStatus, DeviceType, freshness_for
from app.repositories.device_repository import DeviceRepository
from app.services.device_status_service import DeviceStatusService
from app.websocket import agent_channel_routes
from app.websocket.agent_channel import agent_command_channel

AGENT_ID = "agent_PRESENCE_0123456789"


@pytest.fixture()
def factory(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    make = sessionmaker(bind=engine)
    db = make()
    db.add(Device(id=924, agent_id=AGENT_ID, hostname="Mario-Lenovo", platform="windows",
                  device_type=DeviceType.CLIENT, status=DeviceStatus.OFFLINE,
                  last_seen=utcnow() - timedelta(hours=3)))
    db.commit()
    db.close()
    monkeypatch.setattr(agent_channel_routes, "SessionLocal", make)
    agent_command_channel.presence_paused = False
    yield make
    agent_command_channel.presence_paused = False


def _device(make):
    db = make()
    try:
        return DeviceRepository(db).get(924)
    finally:
        db.close()


def _client():
    app = FastAPI()
    app.include_router(agent_channel_routes.router)
    return TestClient(app)


def test_an_agent_opening_its_channel_is_online_at_once(factory):
    assert _device(factory).freshness_state == DeviceFreshnessState.OFFLINE.value
    with _client().websocket_connect(f"/ws/agent/commands?device_id=924&agent_id={AGENT_ID}"):
        # Recorded right after the channel is accepted, in two commits (last
        # seen, then status); the test shares the server's one SQLite
        # connection, so wait for the finished state, not the first write.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not (
            _device(factory).status == DeviceStatus.ONLINE
            and _device(factory).freshness_state == DeviceFreshnessState.ONLINE.value
        ):
            time.sleep(0.02)
        device = _device(factory)
        assert device.status == DeviceStatus.ONLINE
        assert device.freshness_state == DeviceFreshnessState.ONLINE.value


def test_a_lost_channel_makes_the_device_offline_after_the_grace_period(factory):
    db = factory()
    device = DeviceRepository(db).get(924)
    DeviceStatusService(db).mark_online_from_channel(device)
    dropped = utcnow() + timedelta(seconds=1)
    assert DeviceStatusService(db).mark_offline_connection_lost(device, dropped) is True
    db.refresh(device)
    assert device.status == DeviceStatus.OFFLINE
    assert device.offline_reason == "connection_lost"
    # Offline at once, not after ageing through online and stale.
    assert device.freshness_state == DeviceFreshnessState.OFFLINE.value
    assert DeviceRepository(db).count_stats()["offline"] == 1
    db.close()


def test_a_heartbeat_after_the_drop_keeps_the_device_online(factory):
    db = factory()
    device = DeviceRepository(db).get(924)
    DeviceStatusService(db).mark_online_from_channel(device)
    dropped = utcnow() - timedelta(seconds=30)  # the heartbeat came after the drop
    assert DeviceStatusService(db).mark_offline_connection_lost(device, dropped) is False
    db.refresh(device)
    assert device.status == DeviceStatus.ONLINE
    db.close()


def test_a_reconnect_within_the_grace_period_keeps_the_device_online(factory, monkeypatch):
    monkeypatch.setattr(agent_channel_routes, "PRESENCE_GRACE_SECONDS", 0)
    marked = []
    monkeypatch.setattr(agent_channel_routes, "_mark_lost", lambda *a: marked.append(a))
    monkeypatch.setattr(agent_command_channel, "is_connected", lambda device_id: True)
    asyncio.run(agent_channel_routes._offline_after_grace(924, utcnow()))
    assert marked == []


def test_a_backend_shutdown_marks_nobody_offline(factory, monkeypatch):
    monkeypatch.setattr(agent_channel_routes, "PRESENCE_GRACE_SECONDS", 0)
    marked = []
    monkeypatch.setattr(agent_channel_routes, "_mark_lost", lambda *a: marked.append(a))
    monkeypatch.setattr(agent_command_channel, "is_connected", lambda device_id: False)
    agent_channel_routes.cancel_presence_checks()
    asyncio.run(agent_channel_routes._offline_after_grace(924, utcnow()))
    assert marked == []


def test_reconciliation_leaves_a_device_with_an_open_channel_online(factory, monkeypatch):
    db = factory()
    device = DeviceRepository(db).get(924)
    device.status = DeviceStatus.ONLINE
    device.last_seen = utcnow() - timedelta(hours=1)  # heartbeat long overdue
    db.commit()
    monkeypatch.setattr(agent_command_channel, "is_connected", lambda device_id: device_id == 924)
    assert DeviceStatusService(db).reconcile_stale_devices() == 0
    db.refresh(device)
    assert device.status == DeviceStatus.ONLINE
    db.close()


@pytest.mark.parametrize("reason", ["shutdown", "sleep", "connection_lost"])
def test_known_offline_is_offline_at_once_and_counted_so(reason):
    fresh = utcnow()
    assert freshness_for(fresh, DeviceStatus.OFFLINE, reason) == "offline"
    # A timeout offline still ages through stale as before.
    assert freshness_for(fresh, DeviceStatus.OFFLINE, None) == "online"
    assert freshness_for(fresh, DeviceStatus.ONLINE, reason) == "online"


def test_lists_filters_and_counts_agree_on_known_offline(factory):
    db = factory()
    device = DeviceRepository(db).get(924)
    device.status = DeviceStatus.OFFLINE
    device.offline_reason = "shutdown"
    device.last_seen = utcnow()
    db.add(Device(id=925, agent_id="a2", hostname="Other", platform="windows",
                  device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow()))
    db.commit()
    repo = DeviceRepository(db)
    stats = repo.count_stats()
    assert (stats["online"], stats["offline"]) == (1, 1)
    assert [d.id for d in repo.directory()] and {d.id: d.freshness_state for d in repo.directory()} == {924: "offline", 925: "online"}
    online = repo._apply_freshness_filter(db.query(Device), DeviceFreshnessState.ONLINE).all()
    assert [d.id for d in online] == [925]
    db.close()
