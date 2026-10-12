"""Remote Support sessions reported by the agent become an audit trail."""
import json
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow
from app.db.base import Base
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus
from app.models.device_activity_event import DeviceActivityEvent
from app.services.audit_service import AuditAction
from app.services.device_status_service import DeviceStatusService
from app.services.notification_service import NotificationService
from app.services.remote_session_service import RemoteSessionService


@pytest.fixture()
def db(monkeypatch):
    monkeypatch.setattr(NotificationService, "dispatch", lambda self, **kw: None)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def device(db):
    d = Device(hostname="ws-01", rustdesk_id="123456789", status=DeviceStatus.ONLINE,
               last_seen=utcnow().replace(tzinfo=None))
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _connect_click(db, device, *, by="sabina", minutes_ago=2, ip="203.0.113.7"):
    db.add(AuditLog(
        operator_id=7, operator_username=by, action=AuditAction.REMOTE_CONNECT, entity_type="device",
        entity_id=device.id, details_json=json.dumps({"ip": ip}),
        created_at=(utcnow() - timedelta(minutes=minutes_ago)).replace(tzinfo=None),
    ))
    db.commit()


def _audit(db, action):
    return db.query(AuditLog).filter(AuditLog.action == action).all()


def test_a_session_is_attributed_to_the_operator_who_clicked_connect(db, device):
    _connect_click(db, device)
    svc = RemoteSessionService(db)
    start = utcnow()

    svc.apply_report(device, True, now=start)
    assert device.rustdesk_session_active is True
    [started] = _audit(db, AuditAction.REMOTE_SESSION_STARTED)
    assert started.operator_username == "sabina"
    details = json.loads(started.details_json)
    assert details["attribution"] == "connect_request"
    assert details["ip"] == "203.0.113.7"

    svc.apply_report(device, True, now=start + timedelta(minutes=5))  # still live: nothing new
    svc.apply_report(device, False, now=start + timedelta(minutes=23))

    [ended] = _audit(db, AuditAction.REMOTE_SESSION_ENDED)
    assert ended.operator_username == "sabina"
    assert json.loads(ended.details_json)["duration_minutes"] == 23
    assert device.rustdesk_session_active is False
    events = [e.event_type for e in db.query(DeviceActivityEvent).filter_by(device_id=device.id)]
    assert events == ["remote_session_started", "remote_session_ended"]


def test_a_session_without_a_recent_connect_click_is_marked_unattributed(db, device):
    _connect_click(db, device, minutes_ago=40)
    RemoteSessionService(db).apply_report(device, True)

    [started] = _audit(db, AuditAction.REMOTE_SESSION_STARTED)
    assert started.operator_username == "unknown"
    assert json.loads(started.details_json)["attribution"] == "unattributed"


def test_an_agent_that_does_not_report_sessions_changes_nothing(db, device):
    RemoteSessionService(db).apply_report(device, None)
    assert _audit(db, AuditAction.REMOTE_SESSION_STARTED) == []
    assert device.rustdesk_session_active is False


def test_a_device_going_offline_ends_its_session(db, device):
    _connect_click(db, device)
    RemoteSessionService(db).apply_report(device, True)
    device.last_seen = (utcnow() - timedelta(hours=1)).replace(tzinfo=None)
    db.commit()

    DeviceStatusService(db).reconcile_stale_devices()

    [ended] = _audit(db, AuditAction.REMOTE_SESSION_ENDED)
    assert json.loads(ended.details_json)["reason"] == "device_offline"
    assert device.rustdesk_session_active is False
