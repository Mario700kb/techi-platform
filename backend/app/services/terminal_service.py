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

TICKET_ATTACH_GRACE_SECONDS = 60  # time both sides get to attach once the agent knows
SESSION_MAX_SECONDS = 3600        # hard cap on a single session
IDLE_TIMEOUT_SECONDS = 900        # 15 min no traffic → closed

# Backwards-compatible alias: the old name meant "the whole ticket lifetime",
# which is exactly the assumption that was wrong (see ticket_ttl_seconds).
TICKET_TTL_SECONDS = TICKET_ATTACH_GRACE_SECONDS


def ticket_ttl_seconds(platform: Optional[str]) -> int:
    """How long a terminal ticket must stay valid, for this device's platform.

    The agent does not learn about `open_terminal` until its next heartbeat —
    there is no push channel for it. So the ticket has to outlive a full
    heartbeat cycle plus the time both sides need to attach. A flat 60s was
    shorter than every heartbeat interval in the policy, which made opening a
    terminal a race the operator usually lost:

        Linux interval 250s vs ticket 60s → the click only worked if it landed
        in the last ~60s before a heartbeat. Measured on device 729: delivered
        after 34s (worked), 56s (worked, barely), and three attempts that were
        never delivered at all and expired.

    Deriving it from the interval means this cannot drift out of step again
    when an interval is retuned. The attach grace stays 60s — that part was
    never the problem.

    Security note: a ticket is single-use and hashed at rest, but a longer TTL
    does widen the window in which a leaked ticket could still be redeemed.
    That is the deliberate trade for a feature that otherwise fails ~3 times
    out of 4.
    """
    from app.services import agent_config_service as _cfg

    return _cfg.get_heartbeat_interval(platform) + TICKET_ATTACH_GRACE_SECONDS

# Rollout scoping (who FEATURE_TERMINAL is live for) lives in the platform
# expansion package's "rollout" module — reusable by future features, not
# terminal-specific. See app/api/v1/endpoints/terminal.py for the enforcement point.


def _hash_ticket(ticket: str) -> str:
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()


class TerminalService:
    def __init__(self, db: Session):
        self.db = db

    def ticket_ttl_for_device(self, device_id: int) -> int:
        """Ticket lifetime for this device, derived from its platform interval.

        Best-effort: a device row that cannot be read falls back to the flat
        grace period, which is the pre-2026-08-04 behaviour. Opening a terminal
        must not fail because of a lookup.
        """
        try:
            from app.models.device import Device

            platform = self.db.query(Device.platform).filter(Device.id == device_id).scalar()
        except Exception:
            platform = None
        return ticket_ttl_seconds(platform)

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
            expires_at=utcnow() + timedelta(seconds=self.ticket_ttl_for_device(device_id)),
        )
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)
        return session, operator_ticket, agent_ticket

    def create_ssh_session(
        self,
        device_id: int,
        operator_id: Optional[int],
        operator_username: Optional[str],
        *,
        ssh_username: str,
        vault_credential_id: Optional[int],
        credential_source: str,
    ) -> Tuple[TerminalSession, str]:
        """Embedded SSH Connect: same session/ticket model as create_session,
        but there is no separate agent leg to dial in — the backend itself
        attaches as the agent leg (see app/services/ssh_connector.py) — so
        only the operator ticket is meaningful; the agent ticket is still
        generated (and hashed at rest, never returned) purely so this row
        satisfies the same NOT NULL column as every other session, keeping
        one shared schema for both modes."""
        operator_ticket = secrets.token_urlsafe(32)
        agent_ticket = secrets.token_urlsafe(32)
        session = TerminalSession(
            id=uuid.uuid4().hex,
            device_id=device_id,
            operator_id=operator_id,
            operator_username=operator_username,
            engine="ssh",
            mode="ssh",
            ssh_username=ssh_username,
            vault_credential_id=vault_credential_id,
            credential_source=credential_source,
            status=TerminalSessionStatus.PENDING.value,
            operator_ticket_hash=_hash_ticket(operator_ticket),
            agent_ticket_hash=_hash_ticket(agent_ticket),
            expires_at=utcnow() + timedelta(seconds=self.ticket_ttl_for_device(device_id)),
        )
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)
        return session, operator_ticket

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
        # FAILED is also terminal (Embedded SSH Connect: a dial error already
        # recorded a specific reason — credential_missing/host_unreachable/
        # authentication_failed/etc. — a later generic "operator_closed" from
        # the WS route's own cleanup must not clobber that diagnosis).
        if session.status in (
            TerminalSessionStatus.CLOSED.value,
            TerminalSessionStatus.EXPIRED.value,
            TerminalSessionStatus.FAILED.value,
        ):
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
