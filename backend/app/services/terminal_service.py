"""Web Terminal session lifecycle (Platform Expansion Phase 5).

Platform-independent session manager: create → attach (operator + agent) →
active → close/expire. Isolated from every other flow. All entry points are
gated by FEATURE_TERMINAL at the API/WS layer; this service assumes the gate
has already passed.

Tickets: two random one-time tokens (operator + agent), stored only as SHA-256
hashes with a short TTL. Verification is constant-time. Nothing here stores a
device secret.
"""

import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow
from app.models.terminal_session import TerminalSession, TerminalSessionStatus

TICKET_TTL_SECONDS = 60          # both sides must attach within this window
SESSION_MAX_SECONDS = 3600       # hard cap on a single session
IDLE_TIMEOUT_SECONDS = 900       # 15 min no traffic → closed


def _hash_ticket(ticket: str) -> str:
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()


class TerminalService:
    def __init__(self, db: Session):
        self.db = db

    def create_session(
        self, device_id: int, operator_id: Optional[int], operator_username: Optional[str], engine: str = "bash"
    ) -> Tuple[TerminalSession, str, str]:
        """Create a pending session. Returns (session, operator_ticket, agent_ticket).
        The plaintext tickets are returned once and never stored."""
        operator_ticket = secrets.token_urlsafe(32)
        agent_ticket = secrets.token_urlsafe(32)
        session = TerminalSession(
            id=uuid.uuid4().hex,
            device_id=device_id,
            operator_id=operator_id,
            operator_username=operator_username,
            engine=engine if engine in ("bash", "sh") else "bash",
            status=TerminalSessionStatus.PENDING.value,
            operator_ticket_hash=_hash_ticket(operator_ticket),
            agent_ticket_hash=_hash_ticket(agent_ticket),
            expires_at=utcnow() + timedelta(seconds=TICKET_TTL_SECONDS),
        )
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)
        return session, operator_ticket, agent_ticket

    def get(self, session_id: str) -> Optional[TerminalSession]:
        return self.db.query(TerminalSession).filter(TerminalSession.id == session_id).first()

    def _valid_pending(self, session: Optional[TerminalSession]) -> bool:
        if session is None:
            return False
        if session.status not in (TerminalSessionStatus.PENDING.value, TerminalSessionStatus.ACTIVE.value):
            return False
        if (
            session.status == TerminalSessionStatus.PENDING.value
            and utcnow() > ensure_utc(session.expires_at)
        ):
            return False
        return True

    def verify_operator_ticket(self, session_id: str, ticket: str) -> Optional[TerminalSession]:
        session = self.get(session_id)
        if not self._valid_pending(session):
            return None
        if hmac.compare_digest(session.operator_ticket_hash, _hash_ticket(ticket)):
            return session
        return None

    def verify_agent_ticket(self, session_id: str, ticket: str) -> Optional[TerminalSession]:
        session = self.get(session_id)
        if not self._valid_pending(session):
            return None
        if hmac.compare_digest(session.agent_ticket_hash, _hash_ticket(ticket)):
            return session
        return None

    def mark_active(self, session: TerminalSession) -> None:
        if session.status != TerminalSessionStatus.ACTIVE.value:
            session.status = TerminalSessionStatus.ACTIVE.value
            session.started_at = utcnow()
            self.db.commit()

    def close(self, session: TerminalSession, reason: str) -> None:
        if session.status in (TerminalSessionStatus.CLOSED.value, TerminalSessionStatus.EXPIRED.value):
            return
        session.status = (
            TerminalSessionStatus.EXPIRED.value if reason == "expired" else TerminalSessionStatus.CLOSED.value
        )
        session.ended_at = utcnow()
        session.disconnect_reason = reason
        self.db.commit()

    def expire_stale(self) -> int:
        """Mark PENDING sessions whose ticket TTL passed as expired. Returns count."""
        now = utcnow()
        candidates = (
            self.db.query(TerminalSession)
            .filter(TerminalSession.status == TerminalSessionStatus.PENDING.value)
            .all()
        )
        stale = [s for s in candidates if ensure_utc(s.expires_at) < now]
        for session in stale:
            session.status = TerminalSessionStatus.EXPIRED.value
            session.ended_at = now
            session.disconnect_reason = "expired"
        if stale:
            self.db.commit()
        return len(stale)
