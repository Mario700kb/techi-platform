from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, field_validator


class BulkCommandTarget(str, Enum):
    ALL = "all"
    CLIENT = "client"
    GROUP = "group"
    DEVICES = "devices"


BULK_COMMAND_TYPES = frozenset({
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
    "self_update",
})

# Requires admin or owner role
ADMIN_ONLY_COMMAND_TYPES = frozenset({"set_remote_password", "reboot_pc", "run_powershell", "self_update"})

# Requires owner role only
OWNER_ONLY_COMMAND_TYPES = frozenset({"run_powershell"})


class BulkCommandCreate(BaseModel):
    command_type: str
    payload: Dict[str, Any] = {}
    target: BulkCommandTarget
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    device_ids: Optional[List[int]] = None
    timeout_seconds: int = 30

    @field_validator("command_type")
    @classmethod
    def validate_command_type(cls, v: str) -> str:
        if v not in BULK_COMMAND_TYPES:
            raise ValueError(f"Unsupported command_type: {v}")
        return v

    @field_validator("timeout_seconds")
    @classmethod
    def validate_timeout(cls, v: int) -> int:
        if v < 10 or v > 600:
            raise ValueError("timeout_seconds must be between 10 and 600")
        return v


class BatchCreateResponse(BaseModel):
    batch_id: str
    device_count: int
    created_at: datetime


class DeviceCommandStatus(BaseModel):
    device_id: int
    hostname: Optional[str] = None
    status: str
    output: Optional[str] = None
    error: Optional[str] = None


class BatchProgressResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    batch_id: str
    command_type: str
    total: int
    queued: int
    delivered: int
    executing: int
    completed: int
    failed: int
    timeout: int
    percent: int
    devices: List[DeviceCommandStatus]
    created_at: datetime
    finished: bool


class BatchSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    batch_id: str
    command_type: str
    target: str
    total: int
    completed: int
    failed: int
    timeout: int
    finished: bool
    created_at: datetime
    created_by_name: Optional[str] = None
