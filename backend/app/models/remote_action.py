import json
from enum import Enum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy import Enum as SQLEnum
from sqlalchemy.orm import relationship

from app.core.time import utcnow
from app.db.base import Base


class ActionStatus(str, Enum):
    QUEUED = "queued"
    SENT = "sent"
    ACKNOWLEDGED = "acknowledged"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


# Terminal statuses — no further transitions allowed.
TERMINAL_STATUSES = {
    ActionStatus.COMPLETED,
    ActionStatus.FAILED,
    ActionStatus.EXPIRED,
    ActionStatus.CANCELLED,
}

# Statuses that can still be expired by timeout.
EXPIRABLE_STATUSES = {
    ActionStatus.QUEUED,
    ActionStatus.SENT,
    ActionStatus.ACKNOWLEDGED,
    ActionStatus.RUNNING,
}


class RemoteAction(Base):
    __tablename__ = "remote_actions"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    action_type = Column(String(64), nullable=False)
    payload = Column(Text, nullable=True)  # JSON-encoded dict
    status = Column(SQLEnum(ActionStatus), default=ActionStatus.QUEUED, nullable=False, index=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    created_by = Column(String(128), nullable=True)
    queued_at = Column(DateTime, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    failed_at = Column(DateTime, nullable=True)
    cancelled_at = Column(DateTime, nullable=True)
    expired_at = Column(DateTime, nullable=True)
    result_message = Column(String(1024), nullable=True)
    error_message = Column(String(1024), nullable=True)
    output = Column(Text, nullable=True)
    stderr_output = Column(Text, nullable=True)
    execution_timeout_seconds = Column(Integer, default=300, nullable=False)

    device = relationship("Device", back_populates="remote_actions")

    @property
    def payload_dict(self) -> dict:
        if not self.payload:
            return {}
        try:
            return json.loads(self.payload)
        except Exception:
            return {}
