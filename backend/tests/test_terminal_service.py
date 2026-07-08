"""Phase 5 M1 — Web Terminal session lifecycle."""

from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow
from app.db.base import Base
from app.models.terminal_session import TerminalSession, TerminalSessionStatus
from app.services.terminal_service import TerminalService


def _svc():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return TerminalService(sessionmaker(bind=engine)())


def test_create_returns_distinct_tickets_and_stores_only_hashes():
    svc = _svc()
    session, op_ticket, agent_ticket = svc.create_session(device_id=5, operator_id=1, operator_username="mario")
    assert session.status == "pending"
    assert op_ticket != agent_ticket
    # Plaintext tickets are never stored.
    assert op_ticket not in (session.operator_ticket_hash, session.agent_ticket_hash)
    assert session.operator_ticket_hash != session.agent_ticket_hash


def test_ticket_verification_is_side_specific():
    svc = _svc()
    session, op_ticket, agent_ticket = svc.create_session(device_id=5, operator_id=1, operator_username="m")
    # Operator ticket only validates the operator side, agent ticket only the agent side.
    assert svc.verify_operator_ticket(session.id, op_ticket) is not None
    assert svc.verify_operator_ticket(session.id, agent_ticket) is None
    assert svc.verify_agent_ticket(session.id, agent_ticket) is not None
    assert svc.verify_agent_ticket(session.id, op_ticket) is None


def test_wrong_and_unknown_tickets_rejected():
    svc = _svc()
    session, op_ticket, _ = svc.create_session(device_id=5, operator_id=1, operator_username="m")
    assert svc.verify_operator_ticket(session.id, "nope") is None
    assert svc.verify_operator_ticket("unknown-id", op_ticket) is None


def test_mark_active_and_close():
    svc = _svc()
    session, _, _ = svc.create_session(device_id=5, operator_id=1, operator_username="m")
    svc.mark_active(session)
    assert session.status == "active" and session.started_at is not None
    svc.close(session, "operator_closed")
    assert session.status == "closed"
    assert session.disconnect_reason == "operator_closed"
    assert session.ended_at is not None


def test_expired_ticket_not_verifiable():
    svc = _svc()
    session, op_ticket, _ = svc.create_session(device_id=5, operator_id=1, operator_username="m")
    session.expires_at = utcnow() - timedelta(seconds=1)
    svc.db.commit()
    assert svc.verify_operator_ticket(session.id, op_ticket) is None


def test_expire_stale_marks_pending_only():
    svc = _svc()
    s1, _, _ = svc.create_session(device_id=1, operator_id=1, operator_username="m")
    s2, _, _ = svc.create_session(device_id=2, operator_id=1, operator_username="m")
    svc.mark_active(s2)  # active sessions are not expired by TTL
    s1.expires_at = utcnow() - timedelta(seconds=1)
    s2.expires_at = utcnow() - timedelta(seconds=1)
    svc.db.commit()
    assert svc.expire_stale() == 1
    assert svc.get(s1.id).status == "expired"
    assert svc.get(s2.id).status == "active"
