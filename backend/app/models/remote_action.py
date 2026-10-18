import json
from enum import Enum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, SmallInteger, String, Text
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


# Action types supported by agent v2.0 bulk commands
BULK_ACTION_TYPES = frozenset({
    "ping",
    "restart_agent",
    "restart_device",
    "reboot_pc",
    "collect_inventory",
    "sync_rustdesk",
    "restart_rustdesk",
    "set_remote_password",
    "change_heartbeat_interval",
    "run_powershell",
    "register_protocol",
})


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


# Live progress of a long-running action (today: self_update). Stages in the
# order they happen; progress never moves back to an earlier one. The overall
# percentage each stage starts at: downloading runs 5→80 by bytes (reported by
# the agent), completion is 100. restarting/confirming are also set by the
# server from the command channel, so agents that do not report progress
# (≤ 2.1.31) still show them.
ACTION_PROGRESS_STAGES = ("downloading", "verifying", "installing", "restarting", "confirming")
ACTION_STAGE_ORDER = {stage: i for i, stage in enumerate(ACTION_PROGRESS_STAGES)}
ACTION_STAGE_PERCENT = {
    "downloading": 5,
    "verifying": 85,
    "installing": 90,
    "restarting": 95,
    "confirming": 97,
}


class RemoteAction(Base):
    __tablename__ = "remote_actions"

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    action_type = Column(String(64), nullable=False)
    payload = Column(Text, nullable=True)  # JSON-encoded dict
    status = Column(SQLEnum(ActionStatus, native_enum=False, create_constraint=False, values_callable=lambda x: [e.value for e in x]), default=ActionStatus.QUEUED, nullable=False, index=True)
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
    # Overall percent 0–100 and stage (ACTION_PROGRESS_STAGES); both null
    # until the agent or the server reports progress.
    progress = Column(SmallInteger, nullable=True)
    stage = Column(String(24), nullable=True)
    batch_id = Column(String(36), ForeignKey("agent_command_batches.id", ondelete="SET NULL"), nullable=True, index=True)

    device = relationship("Device", back_populates="remote_actions")
    batch = relationship("AgentCommandBatch", back_populates="remote_actions", foreign_keys=[batch_id])

    @property
    def payload_dict(self) -> dict:
        if not self.payload:
            return {}
        try:
            return json.loads(self.payload)
        except Exception:
            return {}
