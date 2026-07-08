from datetime import datetime
from enum import Enum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String

from app.db.base import Base
from app.core.time import utcnow


class TerminalSessionStatus(str, Enum):
    PENDING = "pending"      # created; waiting for operator + agent to attach
    ACTIVE = "active"        # both sides attached, relaying
    CLOSED = "closed"        # ended normally
    EXPIRED = "expired"      # ticket TTL passed before both sides attached
    FAILED = "failed"        # agent could not open a PTY / error


class TerminalSession(Base):
    """A Web Terminal session (Platform Expansion Phase 5).

    Platform-independent: Linux is the first implementation, but MikroTik/
    Synology/etc. reuse the same lifecycle. Isolated from heartbeat/enrollment/
    RustDesk — this table is only read/written by the terminal relay.

    Security: two one-time tickets (hashed at rest) — one for the operator WS,
    one for the agent WS — with a short TTL. Nothing here is a stored secret;
    device SSH credentials (future SSH-mode) come from the Enterprise Vault.
    """

    __tablename__ = "terminal_sessions"

    id = Column(String(64), primary_key=True, index=True)  # uuid4 hex
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=True, index=True)
    operator_username = Column(String(128), nullable=True)

    status = Column(String(16), nullable=False, default=TerminalSessionStatus.PENDING.value, index=True)
    engine = Column(String(24), nullable=False, default="bash")  # bash|sh|ssh (future)

    operator_ticket_hash = Column(String(64), nullable=False)
    agent_ticket_hash = Column(String(64), nullable=False)

    created_at = Column(DateTime, default=utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)          # ticket TTL
    started_at = Column(DateTime, nullable=True)           # both sides attached
    ended_at = Column(DateTime, nullable=True)
    disconnect_reason = Column(String(64), nullable=True)  # operator_closed|idle_timeout|agent_gone|expired|error

    # Prepared for future session recording — NOT written yet (Phase 5 defers it).
    recording_path = Column(String(512), nullable=True)

    @property
    def duration_seconds(self) -> int:
        if self.started_at and self.ended_at:
            return int((self.ended_at - self.started_at).total_seconds())
        return 0
