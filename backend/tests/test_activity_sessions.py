"""Session durations next to the entries that start them, and a terminal
session's end audited once."""
import json
from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import ensure_utc, utcnow, utcnow_naive
from app.db.base import Base
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.terminal_session import TerminalSession
from app.services.activity_sessions import session_spans
from app.services.terminal_service import TerminalService


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add_all([
        Device(id=781, hostname="HV-PROD-01", platform="windows", device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE),
        Device(id=924, hostname="Mario-Lenovo", platform="windows", device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE),
    ])
    db.commit()
    return db


def _audit(db, action, at, details, device_id=None, entity_type="device", entity_id=None):
    entry = AuditLog(action=action, entity_type=entity_type, entity_id=entity_id, device_id=device_id,
                     details_json=json.dumps(details), created_at=at)
    db.add(entry)
    db.commit()
    return entry


def _terminal(db, sid, started, ended=None, status="closed", reason="operator_closed"):
    db.add(TerminalSession(id=sid, device_id=781, operator_id=1, operator_username="denis", status=status,
                           engine="powershell", operator_ticket_hash="x", agent_ticket_hash="y",
                           created_at=started, started_at=started, ended_at=ended, disconnect_reason=reason,
                           expires_at=started + timedelta(minutes=5)))
    db.commit()


def test_an_opened_console_shows_how_long_it_lasted_or_that_it_is_live():
    db = _db()
    t0 = utcnow_naive() - timedelta(hours=1)
    _terminal(db, "a" * 32, t0, t0 + timedelta(seconds=55))
    _terminal(db, "b" * 32, t0 + timedelta(minutes=30), status="active", reason=None)
    done = _audit(db, "terminal_session_opened", t0, {"session_id": "a" * 32, "engine": "powershell"},
                  device_id=781, entity_type="terminal_session")
    live = _audit(db, "terminal_session_opened", t0 + timedelta(minutes=30), {"session_id": "b" * 32},
                  device_id=781, entity_type="terminal_session")
    spans = session_spans(db, [done, live])
    assert spans[done.id].duration_seconds == 55 and spans[done.id].end_reason == "operator_closed"
    assert spans[live.id].duration_seconds is None
    assert spans[live.id].live_since == ensure_utc(t0 + timedelta(minutes=30))


def test_a_connect_click_and_its_remote_session_show_the_session_length():
    db = _db()
    click = utcnow_naive() - timedelta(minutes=40)
    started = click + timedelta(seconds=2)
    connect = _audit(db, "remote_connect", click, {"ip": "79.98.115.19"}, device_id=924, entity_id=924)
    start = _audit(db, "remote_session_started", started,
                   {"attribution": "connect_request", "connect_requested_at": ensure_utc(click).isoformat()},
                   device_id=924, entity_id=924)
    _audit(db, "remote_session_ended", started + timedelta(minutes=18),
           {"duration_minutes": 18, "started_at": ensure_utc(started).isoformat(), "reason": "session_closed"},
           device_id=924, entity_id=924)
    lonely = _audit(db, "remote_connect", click - timedelta(hours=2), {}, device_id=781, entity_id=781)

    spans = session_spans(db, [connect, start, lonely])
    assert spans[start.id].duration_seconds == 18 * 60
    assert spans[connect.id].duration_seconds == 18 * 60
    assert spans[start.id].end_reason == "session_closed"
    assert spans[lonely.id].no_session is True  # a click that started nothing says so


def test_a_remote_session_still_open_is_live():
    db = _db()
    started = utcnow_naive() - timedelta(minutes=7)
    device = db.get(Device, 924)
    device.rustdesk_session_active = True
    device.rustdesk_session_started_at = started
    db.commit()
    start = _audit(db, "remote_session_started", started, {"attribution": "unattributed"}, device_id=924, entity_id=924)
    span = session_spans(db, [start])[start.id]
    assert span.live_since == ensure_utc(started) and span.duration_seconds is None


def test_only_the_first_close_of_a_session_counts():
    db = _db()
    _terminal(db, "c" * 32, utcnow_naive() - timedelta(minutes=1), status="active", reason=None)
    first, second = TerminalService(db), TerminalService(db)
    s1 = first.get("c" * 32)
    s2 = second.get("c" * 32)
    assert first.close(s1, "operator_closed") is True
    assert second.close(s2, "agent_gone") is False
    assert s2.disconnect_reason == "operator_closed" and s2.ended_at is not None
    assert ensure_utc(s2.ended_at) <= utcnow()


def test_a_session_whose_end_was_noticed_later_keeps_its_real_length():
    db = _db()
    started = utcnow_naive() - timedelta(minutes=30)
    start = _audit(db, "remote_session_started", started, {}, device_id=781, entity_id=781)
    # Ended after 54 s; the lost close was noticed 19 minutes later.
    _audit(db, "remote_session_ended", started + timedelta(minutes=19),
           {"duration_minutes": 1, "started_at": ensure_utc(started).isoformat(),
            "ended_at": ensure_utc(started + timedelta(seconds=54)).isoformat(),
            "close_report": "lost", "reason": "session_closed"},
           device_id=781, entity_id=781)
    assert session_spans(db, [start])[start.id].duration_seconds == 54


def test_an_older_lost_close_without_its_end_time_uses_the_recorded_minutes():
    db = _db()
    started = utcnow_naive() - timedelta(minutes=30)
    start = _audit(db, "remote_session_started", started, {}, device_id=781, entity_id=781)
    _audit(db, "remote_session_ended", started + timedelta(minutes=19),
           {"duration_minutes": 1, "started_at": ensure_utc(started).isoformat(), "close_report": "lost"},
           device_id=781, entity_id=781)
    assert session_spans(db, [start])[start.id].duration_seconds == 60


def test_the_activity_log_shows_one_row_per_session():
    from app.repositories.audit_log_repository import AuditLogRepository

    db = _db()
    t0 = utcnow_naive() - timedelta(hours=1)

    def add(action, minutes, details, device_id=924, entity_type="device"):
        entry = _audit(db, action, t0 + timedelta(minutes=minutes), details, device_id=device_id,
                       entity_type=entity_type, entity_id=device_id if entity_type == "device" else None)
        entry.client_id = 1
        db.commit()
        return entry

    connect = add("remote_connect", 0, {"ip": "79.98.115.19"})
    add("remote_session_started", 0.05, {"attribution": "connect_request",
                                         "connect_requested_at": ensure_utc(t0).isoformat()})
    add("remote_session_ended", 18, {"started_at": ensure_utc(t0 + timedelta(minutes=0.05)).isoformat(),
                                     "duration_minutes": 18})
    stranger = add("remote_session_started", 30, {"attribution": "unattributed"})
    opened = add("terminal_session_opened", 40, {"session_id": "a" * 32}, device_id=781, entity_type="terminal_session")
    add("terminal_session_closed", 41, {"session_id": "a" * 32, "duration_seconds": 55},
        device_id=781, entity_type="terminal_session")
    queued = add("action_queued", 50, {"action_type": "ping"})

    total, rows = AuditLogRepository(db).for_client(1, None, 50, 0, one_row_per_session=True)
    assert [r.id for r in rows] == [queued.id, opened.id, stranger.id, connect.id]
    assert total == 4
    everything, _ = AuditLogRepository(db).for_client(1, None, 50, 0)
    assert everything == 7  # nothing is removed from the audit log itself


def test_a_connect_click_that_opened_no_session_says_so():
    db = _db()
    old = _audit(db, "remote_connect", utcnow_naive() - timedelta(minutes=30), {}, device_id=924, entity_id=924)
    fresh = _audit(db, "remote_connect", utcnow_naive() - timedelta(minutes=2), {}, device_id=924, entity_id=924)
    spans = session_spans(db, [old, fresh])
    assert spans[old.id].no_session is True
    assert fresh.id not in spans  # still within the time a session may start


def test_a_second_click_during_an_open_session_joins_it():
    db = _db()
    click = utcnow_naive() - timedelta(minutes=40)
    started = click + timedelta(seconds=2)
    _audit(db, "remote_connect", click, {}, device_id=781, entity_id=781)
    _audit(db, "remote_session_started", started,
           {"attribution": "connect_request", "connect_requested_at": ensure_utc(click).isoformat()},
           device_id=781, entity_id=781)
    second = _audit(db, "remote_connect", click + timedelta(seconds=22), {}, device_id=781, entity_id=781)
    _audit(db, "remote_session_ended", started + timedelta(seconds=54),
           {"started_at": ensure_utc(started).isoformat(), "ended_at": ensure_utc(started + timedelta(seconds=54)).isoformat()},
           device_id=781, entity_id=781)
    later = _audit(db, "remote_connect", click + timedelta(minutes=5), {}, device_id=781, entity_id=781)
    spans = session_spans(db, [second, later])
    assert spans[second.id].joined is True and spans[second.id].duration_seconds == 54
    assert spans[later.id].no_session is True  # after that session ended, nothing joined
