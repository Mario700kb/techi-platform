"""Terminal watchdog (Platform Expansion Phase 5) — the periodic sweep that
prevents orphan sessions: expiring PENDING tickets past TTL, and force-closing
ACTIVE relay pairs past idle-timeout/max-duration, with an audit entry either
way. DB access is isolated per test via a monkeypatched SessionLocal; the
relay is a fresh instance per test (constructed inside the running loop, same
requirement as test_terminal_relay.py).
"""

import asyncio
import json
from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow
from app.db.base import Base
from app.models.audit_log import AuditLog
from app.models.terminal_session import TerminalSession
from app.services import terminal_relay as relay_module
from app.services.terminal_relay import TerminalRelay
from app.services.terminal_service import TerminalService
from app.workers import terminal_watchdog as watchdog_module
from app.workers.terminal_watchdog import TerminalWatchdog


class _FakeWS:
    async def close(self):
        pass


def _sqlite_session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)


def test_run_once_expires_stale_pending_sessions_and_audits(monkeypatch):
    session_factory = _sqlite_session_factory()
    monkeypatch.setattr(watchdog_module, "SessionLocal", session_factory)

    db = session_factory()
    svc = TerminalService(db)
    session, _, _ = svc.create_session(device_id=1, operator_id=1, operator_username="m")
    session_id = session.id  # capture before commit() expires the instance
    session.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    db.close()

    # TerminalWatchdog() must be constructed inside a running loop (its
    # asyncio.Event() needs one, same requirement as TerminalRelay's Lock).
    async def _run():
        wd = TerminalWatchdog()
        return await wd.run_once()

    closed = asyncio.run(_run())
    assert closed == 1

    check_db = session_factory()
    refreshed = check_db.get(TerminalSession, session_id)
    assert refreshed.status == "expired"
    audit_rows = check_db.query(AuditLog).filter(AuditLog.action == "terminal_session_expired").all()
    assert len(audit_rows) == 1
    assert json.loads(audit_rows[0].details_json)["count"] == 1


def test_run_once_is_a_noop_when_nothing_stale(monkeypatch):
    session_factory = _sqlite_session_factory()
    monkeypatch.setattr(watchdog_module, "SessionLocal", session_factory)

    async def _run():
        wd = TerminalWatchdog()
        return await wd.run_once()

    assert asyncio.run(_run()) == 0


def test_run_once_force_closes_idle_relay_pair_and_audits(monkeypatch):
    session_factory = _sqlite_session_factory()
    monkeypatch.setattr(watchdog_module, "SessionLocal", session_factory)

    async def _body():
        fresh_relay = TerminalRelay()
        monkeypatch.setattr(watchdog_module, "terminal_relay", fresh_relay)
        monkeypatch.setattr(relay_module.time, "monotonic", lambda: 1000.0)

        db = session_factory()
        svc = TerminalService(db)
        session, _, _ = svc.create_session(device_id=7, operator_id=1, operator_username="mario")
        session_id = session.id
        db.close()

        await fresh_relay.attach_operator(session_id, _FakeWS())
        await fresh_relay.attach_agent(session_id, _FakeWS())

        monkeypatch.setattr(relay_module.time, "monotonic", lambda: 1000.0 + 901)

        wd = TerminalWatchdog()
        closed = await wd.run_once()
        assert closed == 1
        assert fresh_relay.is_active(session_id) is False

        check_db = session_factory()
        refreshed = check_db.get(TerminalSession, session_id)
        assert refreshed.status == "closed"
        assert refreshed.disconnect_reason == "idle_timeout"
        audit_rows = check_db.query(AuditLog).filter(AuditLog.action == "terminal_session_closed").all()
        assert len(audit_rows) == 1
        details = json.loads(audit_rows[0].details_json)
        assert details["session_id"] == session_id
        assert details["device_id"] == 7
        assert details["reason"] == "idle_timeout"

    asyncio.run(_body())


def test_start_stop_lifecycle_does_not_raise(monkeypatch):
    session_factory = _sqlite_session_factory()
    monkeypatch.setattr(watchdog_module, "SessionLocal", session_factory)

    async def _body():
        wd = TerminalWatchdog()
        wd.start()
        assert wd._task is not None and not wd._task.done()
        await wd.stop()
        assert wd._task.cancelled() or wd._task.done()

    asyncio.run(_body())
