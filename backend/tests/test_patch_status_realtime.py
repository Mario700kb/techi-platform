"""A patch report from the agent reaches open screens as patch_status_updated,
so the "N updates" chip follows it without a reload.

Runs the real heartbeat service on SQLite with the publisher captured.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.schemas.agent import AgentHeartbeatPayload
from app.services import device_heartbeat_service
from app.services.device_heartbeat_service import DeviceHeartbeatService

AGENT_ID = "agent_PATCH_9Kd3Wq7Zr2Np"


@pytest.fixture(autouse=True)
def _empty_agent_cache():
    device_heartbeat_service._AGENT_ID_CACHE.clear()
    yield
    device_heartbeat_service._AGENT_ID_CACHE.clear()


@pytest.fixture()
def events(monkeypatch):
    published = []
    monkeypatch.setattr(
        device_heartbeat_service.realtime_publisher,
        "publish_threadsafe",
        lambda event, dedupe_key=None: published.append(event),
    )
    return published


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def device(db):
    d = Device(
        agent_id=AGENT_ID,
        hostname="adp-ws-14",
        platform="windows",
        device_type=DeviceType.CLIENT,
        status=DeviceStatus.ONLINE,
        rustdesk_id="987654321",
        client_id=3,
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _beat(db, **fields):
    payload = AgentHeartbeatPayload(
        hostname="adp-ws-14", platform="windows", rustdesk_id="987654321", agent_id=AGENT_ID, **fields
    )
    DeviceHeartbeatService(db).process_heartbeat(payload)


def _patch_events(events):
    return [e for e in events if e["type"] == "patch_status_updated"]


def test_a_patch_report_is_published_with_the_scope_fields(db, device, events):
    _beat(db, patch_status={"pending_updates": 384, "patch_state": "updates_available", "reboot_required": False})

    [event] = _patch_events(events)
    assert event["data"] == {
        "id": device.id,
        "client_id": 3,
        "group_id": None,
        "pending_updates": 384,
        "reboot_required": False,
        "last_update_at": None,
        "patch_state": "updates_available",
    }


def test_a_heartbeat_without_a_patch_report_publishes_none(db, device, events):
    _beat(db, processes=[{"pid": 4, "name": "System"}])

    assert _patch_events(events) == []
