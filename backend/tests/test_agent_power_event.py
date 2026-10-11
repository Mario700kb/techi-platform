"""An agent tells the platform its machine is shutting down or going to sleep.

Staff switching their PCs off at the end of the day used to surface as a
CRITICAL "went offline" alert per workstation, because the only offline path
was the stale-heartbeat reconciliation, which cannot tell a switched-off PC
from a dead server. The power event moves the device offline at once with the
reason recorded, so reconciliation never selects it. A Client PC raises
nothing; anything else (servers above all) still raises a WARNING, because a
server being switched off is worth knowing even when it was done cleanly.

The endpoint must stay closed to callers that cannot prove the device's
agent_id: the heartbeat endpoint is public, and an open power event would let
anyone silence the offline alert of any device they can name.
"""
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints.agent import router as agent_router
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_status_history import DeviceStatusHistory
from app.services.device_activity_service import DeviceActivityService
from app.services.device_status_service import DeviceStatusService
from app.services.notification_service import NotificationService

AGENT_ID = "agent_HnW3xK9pQ2rLmT7vZaB4cD6e"


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def client(db):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.include_router(agent_router, prefix="/api/v1/agent")
    return TestClient(app)


@pytest.fixture()
def notifications(monkeypatch):
    calls = []
    monkeypatch.setattr(NotificationService, "dispatch", lambda self, **kw: calls.append(kw))
    return calls


def _device(db, **overrides):
    fields = dict(
        hostname="ws-01",
        agent_id=AGENT_ID,
        device_type=DeviceType.CLIENT,
        os_name="Windows 11 Pro",
        status=DeviceStatus.ONLINE,
        last_seen=utcnow(),
    )
    fields.update(overrides)
    device = Device(**fields)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def _server(db):
    return _device(db, hostname="srv-01", device_type=DeviceType.SERVER, os_name="Windows Server 2022 Standard")


def _post(client, device_id, *, state="shutdown", agent_id=AGENT_ID):
    return client.post(
        "/api/v1/agent/power-event",
        json={"device_id": device_id, "agent_id": agent_id, "state": state},
    )


def _alerts(db, device_id):
    return db.query(DeviceAlert).filter(DeviceAlert.device_id == device_id).all()


def _history_reasons(db, device_id):
    rows = db.query(DeviceStatusHistory).filter(DeviceStatusHistory.device_id == device_id).all()
    return [r.reason for r in rows]


def test_client_pc_shutdown_goes_offline_without_an_alert(client, db, notifications):
    device = _device(db)

    response = _post(client, device.id)

    assert response.status_code == 204
    db.refresh(device)
    assert device.status == DeviceStatus.OFFLINE
    assert device.offline_reason == "shutdown"
    assert device.offline_confidence == "high"
    assert device.last_shutdown_time is not None
    assert _history_reasons(db, device.id) == ["agent_shutdown"]
    assert _alerts(db, device.id) == []
    assert notifications == []


def test_client_pc_sleep_is_recorded_as_sleep(client, db, notifications):
    device = _device(db)

    assert _post(client, device.id, state="sleep").status_code == 204

    db.refresh(device)
    assert device.status == DeviceStatus.OFFLINE
    assert device.offline_reason == "sleep"
    assert device.last_shutdown_time is None
    assert _history_reasons(db, device.id) == ["agent_sleep"]
    assert _alerts(db, device.id) == []


def test_server_shutdown_raises_a_warning_not_a_critical(client, db, notifications):
    device = _server(db)

    assert _post(client, device.id).status_code == 204

    alerts = _alerts(db, device.id)
    assert len(alerts) == 1
    assert alerts[0].kind == AlertKind.DEVICE_OFFLINE
    assert alerts[0].severity == AlertSeverity.WARNING
    assert alerts[0].message == "srv-01 was shut down"
    event_types = {c["event_type"] for c in notifications}
    assert "device_offline" in event_types
    assert "critical_alert" not in event_types


def test_server_warning_resolves_when_it_comes_back(client, db, notifications):
    device = _server(db)
    _post(client, device.id)

    DeviceStatusService(db).mark_online_from_heartbeat(device)

    db.refresh(device)
    assert device.offline_reason is None
    assert device.offline_confidence is None
    assert [a.state for a in _alerts(db, device.id)] == [AlertState.RESOLVED]


def test_reconciliation_skips_a_device_that_reported_shutdown(client, db, notifications):
    device = _device(db, last_seen=utcnow() - timedelta(hours=2))
    _post(client, device.id)

    assert DeviceStatusService(db).reconcile_stale_devices() == 0
    assert _alerts(db, device.id) == []
    assert _history_reasons(db, device.id) == ["agent_shutdown"]


def test_silent_disappearance_still_raises_the_critical_alert(db, notifications):
    """Unchanged behaviour: a PC that vanishes without a power event (power cut,
    network loss, crash) still goes through reconciliation as before."""
    device = _device(db, last_seen=utcnow() - timedelta(hours=2))

    assert DeviceStatusService(db).reconcile_stale_devices() == 1

    db.refresh(device)
    assert device.status == DeviceStatus.OFFLINE
    assert device.offline_reason is None
    assert _history_reasons(db, device.id) == ["heartbeat_timeout_exceeded"]
    alerts = _alerts(db, device.id)
    assert [a.severity for a in alerts] == [AlertSeverity.CRITICAL]


def test_already_offline_device_is_left_alone(client, db, notifications):
    device = _device(db, status=DeviceStatus.OFFLINE)

    assert _post(client, device.id).status_code == 204

    db.refresh(device)
    assert device.offline_reason is None
    assert _history_reasons(db, device.id) == []


@pytest.mark.parametrize(
    "agent_id",
    [
        pytest.param("agent_wrong", id="wrong"),
        pytest.param("", id="empty"),
        pytest.param(AGENT_ID[:-1], id="truncated"),
    ],
)
def test_wrong_agent_id_is_refused_and_changes_nothing(client, db, notifications, agent_id):
    device = _device(db)

    assert _post(client, device.id, agent_id=agent_id).status_code == 403

    db.refresh(device)
    assert device.status == DeviceStatus.ONLINE
    assert _history_reasons(db, device.id) == []


def test_device_without_agent_id_is_never_unlocked(client, db, notifications):
    device = _device(db, agent_id=None)

    assert _post(client, device.id, agent_id="").status_code == 403

    db.refresh(device)
    assert device.status == DeviceStatus.ONLINE


def test_unknown_device_gets_the_same_403(client, db, notifications):
    response = _post(client, 9999)

    assert response.status_code == 403
    assert response.json()["detail"] == "Unknown device or agent_id"


def test_unknown_state_is_rejected(client, db, notifications):
    device = _device(db)

    assert _post(client, device.id, state="reboot").status_code == 422


def test_timeline_puts_the_offline_reason_only_on_the_latest_transition(db):
    """The stored offline_reason describes the current outage only; older
    offline rows keep their own recorded reason."""
    device = _device(db, status=DeviceStatus.OFFLINE, offline_reason="shutdown", offline_confidence="high")
    start = utcnow() - timedelta(hours=3)
    for minutes, new_status, reason in [
        (0, DeviceStatus.OFFLINE, "heartbeat_timeout_exceeded"),
        (30, DeviceStatus.ONLINE, "heartbeat_received"),
        (60, DeviceStatus.OFFLINE, "agent_sleep"),
        (90, DeviceStatus.ONLINE, "heartbeat_received"),
        (120, DeviceStatus.OFFLINE, "agent_shutdown"),
    ]:
        db.add(DeviceStatusHistory(
            device_id=device.id,
            new_status=new_status,
            reason=reason,
            created_at=start + timedelta(minutes=minutes),
        ))
    db.commit()

    feed = DeviceActivityService(db).get_activity_feed(device.id)
    offline_details = [e.detail for e in feed if e.type == "device_offline"]

    assert offline_details == [
        "Likely reason: Shutdown · Confidence: High",
        "Went to sleep",
        "Timeout exceeded",
    ]
