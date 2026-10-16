"""RustDesk's own connection reports (/api/audit/conn, /api/audit/alarm).

Bodies are the ones RustDesk 1.4.6 builds in src/server/connection.rs
(post_conn_audit, post_alarm_audit). Reports carry no credential, so only a
known RustDesk ID sent from the device's own public IP counts.
"""
import json
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.api.rustdesk_audit import router
from app.core.time import utcnow_naive
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_activity_event import DeviceActivityEvent
from app.models.remote_support_connection import RemoteSupportConnection
from app.services.audit_service import AuditAction

DEVICE_IP = "88.198.53.124"
RUSTDESK_ID = "490082564"
SESSION = 7364412900137715231  # a u64 the controlling client picks


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
        agent_id="agent_x",
        hostname="kubiti-sql-srv",
        platform="windows",
        device_type=DeviceType.SERVER,
        status=DeviceStatus.ONLINE,
        rustdesk_id=RUSTDESK_ID,
        public_ip=DEVICE_IP,
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _client(db, ip=DEVICE_IP):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.include_router(router)
    return TestClient(app, client=(ip, 50000))


def _conn(client, conn_id, **extra):
    body = {"id": RUSTDESK_ID, "uuid": "dXVpZA==", "conn_id": conn_id, "session_id": SESSION, **extra}
    response = client.post("/api/audit/conn", json=body)
    assert response.status_code == 204
    return response


def _opened(client, conn_id):
    _conn(client, conn_id, action="new", ip="79.98.115.19")


def _accepted(client, conn_id, conn_type=0):
    _conn(client, conn_id, peer=["123456789", "Denis-MacBook"], type=conn_type)


def _closed(client, conn_id):
    _conn(client, conn_id, action="close")


def _audit(db, action):
    return db.query(AuditLog).filter(AuditLog.action == action).order_by(AuditLog.id).all()


def test_a_connection_is_recorded_and_makes_a_session(db, device):
    client = _client(db)
    _opened(client, 3)
    _accepted(client, 3)
    db.refresh(device)
    assert device.rustdesk_session_active is True

    _closed(client, 3)
    db.refresh(device)
    assert device.rustdesk_session_active is False

    (row,) = db.query(RemoteSupportConnection).all()
    assert (row.device_id, row.conn_id, row.session_id) == (device.id, 3, str(SESSION))
    assert (row.peer_id, row.peer_name, row.peer_ip, row.conn_type) == ("123456789", "Denis-MacBook", "79.98.115.19", 0)
    assert row.opened_at and row.authorized_at and row.closed_at

    (started,) = _audit(db, AuditAction.REMOTE_SESSION_STARTED)
    (ended,) = _audit(db, AuditAction.REMOTE_SESSION_ENDED)
    for entry in (started, ended):
        details = json.loads(entry.details_json)
        assert details["source"] == "rustdesk"
        assert details["peer_name"] == "Denis-MacBook"
        assert details["connection_type"] == "remote desktop"
    events = [e.event_type for e in db.query(DeviceActivityEvent).order_by(DeviceActivityEvent.id)]
    assert events == ["remote_session_started", "remote_session_ended"]


def test_a_report_from_another_address_is_ignored(db, device):
    client = _client(db, ip="203.0.113.9")
    _opened(client, 3)
    _accepted(client, 3)

    assert db.query(RemoteSupportConnection).count() == 0
    db.refresh(device)
    assert device.rustdesk_session_active is False


def test_an_unknown_rustdesk_id_is_ignored(db, device):
    client = _client(db)
    response = client.post("/api/audit/conn", json={"id": "111222333", "conn_id": 1, "action": "new"})
    assert response.status_code == 204
    assert db.query(RemoteSupportConnection).count() == 0


def test_a_drop_and_its_reconnection_end_and_start_the_session(db, device):
    client = _client(db)
    _opened(client, 3)
    _accepted(client, 3)
    _closed(client, 3)  # Windows switched session; RustDesk restarted its server
    _opened(client, 1)
    _accepted(client, 1)

    rows = db.query(RemoteSupportConnection).order_by(RemoteSupportConnection.id).all()
    assert [r.session_id for r in rows] == [str(SESSION), str(SESSION)]
    assert [a.action for a in db.query(AuditLog).order_by(AuditLog.id)] == [
        AuditAction.REMOTE_SESSION_STARTED,
        AuditAction.REMOTE_SESSION_ENDED,
        AuditAction.REMOTE_SESSION_STARTED,
    ]


def test_the_session_lasts_until_the_last_connection_closes(db, device):
    client = _client(db)
    _opened(client, 3)
    _accepted(client, 3)
    _opened(client, 4)
    _accepted(client, 4, conn_type=1)

    _closed(client, 3)
    db.refresh(device)
    assert device.rustdesk_session_active is True
    _closed(client, 4)
    db.refresh(device)
    assert device.rustdesk_session_active is False
    assert len(_audit(db, AuditAction.REMOTE_SESSION_STARTED)) == 1


def test_an_unanswered_password_prompt_does_not_make_a_session(db, device):
    client = _client(db)
    _opened(client, 5)
    _closed(client, 5)

    (row,) = db.query(RemoteSupportConnection).all()
    assert row.authorized_at is None and row.closed_at is not None
    assert db.query(AuditLog).count() == 0


def test_a_connection_left_open_long_ago_does_not_hold_the_session(db, device):
    db.add(
        RemoteSupportConnection(
            device_id=device.id,
            conn_id=9,
            opened_at=utcnow_naive() - timedelta(days=2),
            authorized_at=utcnow_naive() - timedelta(days=2),
        )
    )
    db.commit()
    client = _client(db)
    _opened(client, 3)
    _accepted(client, 3)
    _closed(client, 3)

    db.refresh(device)
    assert device.rustdesk_session_active is False


def test_the_session_is_attributed_to_the_operator_who_pressed_connect(db, device):
    db.add(
        AuditLog(
            operator_id=1,
            operator_username="denis",
            action=AuditAction.REMOTE_CONNECT,
            entity_type="device",
            entity_id=device.id,
            created_at=utcnow_naive() - timedelta(seconds=20),
        )
    )
    db.commit()
    client = _client(db)
    _opened(client, 3)
    _accepted(client, 3)

    (started,) = _audit(db, AuditAction.REMOTE_SESSION_STARTED)
    assert started.operator_username == "denis"


def test_refused_logins_are_recorded(db, device):
    client = _client(db)
    info = json.dumps({"ip": "203.0.113.9", "id": "987654321", "name": "unknown-pc"})
    response = client.post("/api/audit/alarm", json={"id": RUSTDESK_ID, "uuid": "dXVpZA==", "typ": 2, "info": info})
    assert response.status_code == 204

    (entry,) = _audit(db, AuditAction.REMOTE_SUPPORT_ALARM)
    details = json.loads(entry.details_json)
    assert details["reason"] == "more than 6 wrong passwords in a minute"
    assert (details["caller"], details["caller_ip"]) == ("unknown-pc", "203.0.113.9")
    (event,) = db.query(DeviceActivityEvent).all()
    assert event.event_type == "remote_support_alarm"


def test_a_malformed_report_is_rejected(db, device):
    client = _client(db)
    assert client.post("/api/audit/conn", json={"action": "new"}).status_code == 422
    assert client.post("/api/audit/alarm", json={"id": RUSTDESK_ID, "typ": 2, "info": "not json"}).status_code == 204
