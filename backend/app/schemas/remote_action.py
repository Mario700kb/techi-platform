import json
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, model_validator


class ActionStatus(str, Enum):
    QUEUED = "queued"
    SENT = "sent"
    ACKNOWLEDGED = "acknowledged"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class ActionType(str, Enum):
    PING = "ping"
    RESTART_DEVICE = "restart_device"
    REFRESH_INVENTORY = "refresh_inventory"
    RESTART_AGENT = "restart_agent"
    SYNC_RUSTDESK = "sync_rustdesk"


# Human-readable labels used in the UI.
ACTION_LABELS: Dict[str, str] = {
    ActionType.PING: "Ping",
    ActionType.RESTART_DEVICE: "Restart Device",
    ActionType.REFRESH_INVENTORY: "Refresh Inventory",
    ActionType.RESTART_AGENT: "Restart Agent",
    ActionType.SYNC_RUSTDESK: "Sync RustDesk",
}


class RemoteActionCreate(BaseModel):
    action_type: ActionType
    parameters: Optional[Dict[str, Any]] = None
    created_by: Optional[str] = None
    execution_timeout_seconds: Optional[int] = 300


class RemoteActionAck(BaseModel):
    pass


class RemoteActionRunning(BaseModel):
    pass


class RemoteActionComplete(BaseModel):
    result_message: Optional[str] = None


class RemoteActionFail(BaseModel):
    error_message: Optional[str] = None


class RemoteActionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: int
    action_type: str
    parameters: Optional[Dict[str, Any]] = None
    status: ActionStatus
    created_at: datetime
    created_by: Optional[str] = None
    queued_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    acknowledged_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    failed_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    expired_at: Optional[datetime] = None
    result_message: Optional[str] = None
    error_message: Optional[str] = None
    execution_timeout_seconds: int
    duration_seconds: Optional[float] = None

    @model_validator(mode="before")
    @classmethod
    def parse_payload(cls, data):
        """Convert DB payload (JSON string) → parameters dict."""
        if hasattr(data, "__dict__") or hasattr(data, "payload"):
            raw = getattr(data, "payload", None)
            if isinstance(raw, str):
                try:
                    data.__dict__["parameters"] = json.loads(raw)
                except Exception:
                    data.__dict__["parameters"] = {}
            elif isinstance(raw, dict):
                data.__dict__["parameters"] = raw
        return data

    @model_validator(mode="after")
    def compute_duration(self) -> "RemoteActionResponse":
        if self.started_at is None:
            return self
        end = self.completed_at or self.failed_at
        if end:
            self.duration_seconds = (end - self.started_at).total_seconds()
        elif self.status == ActionStatus.RUNNING:
            self.duration_seconds = (datetime.utcnow() - self.started_at).total_seconds()
        return self


class RemoteActionWithDevice(RemoteActionResponse):
    device_hostname: Optional[str] = None


class ActionStatusStats(BaseModel):
    queued: int = 0
    sent: int = 0
    acknowledged: int = 0
    running: int = 0
    completed: int = 0
    failed: int = 0
    expired: int = 0
    cancelled: int = 0
    total: int = 0


# Lightweight payload returned to the agent inside the heartbeat response.
class PendingActionDelivery(BaseModel):
    action_id: int
    action: str
    parameters: Dict[str, Any]
    timeout_seconds: int
    callback_secret: str
