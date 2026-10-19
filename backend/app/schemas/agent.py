from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.device import DeviceStatus, DeviceType
from app.schemas.remote_action import PendingActionDelivery


class AgentHeartbeatPayload(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    agent_id: Optional[str] = None
    device_id: Optional[int] = None
    rustdesk_id: Optional[str] = None
    rustdesk_enc_id: Optional[str] = None
    # Windows MachineGuid (agents >= 2.1.34): Remote Support's uuid is its
    # base64, which ties the client's own ID report to this device.
    machine_guid: Optional[str] = Field(default=None, max_length=64)
    hostname: Optional[str] = None
    current_user: Optional[str] = None
    user_source: Optional[str] = None
    user_session_state: Optional[str] = None
    domain: Optional[str] = None
    public_ip: Optional[str] = None
    local_ip: Optional[str] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    os_caption: Optional[str] = None
    os_build: Optional[str] = None
    windows_product_type: Optional[int] = None
    platform: Optional[str] = None
    # Platform Expansion — optional, sent only by platform-aware agents
    # (Windows agents never send these; contract stays backward compatible).
    fqdn: Optional[str] = None
    kernel_version: Optional[str] = None
    architecture: Optional[str] = None
    mac_address: Optional[str] = None
    timezone: Optional[str] = None
    last_boot_at: Optional[datetime] = None
    capabilities: Optional[Any] = None  # list[str] or {name: version}; normalized server-side
    cpu: Optional[str] = None
    ram: Optional[str] = None
    storage: Optional[str] = None
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    rustdesk_install_status: Optional[str] = None
    rustdesk_status: Optional[str] = None
    rustdesk_version: Optional[str] = None
    rustdesk_install_path: Optional[str] = None
    rustdesk_last_repair_at: Optional[datetime] = None
    rustdesk_repair_count: Optional[int] = None
    # A live Remote Support session on the device (agents >= 2.1.24); None
    # when the agent does not report it or could not tell.
    remote_session_active: Optional[bool] = None
    cpu_percent: Optional[float] = None
    ram_percent: Optional[float] = None
    disk_percent: Optional[float] = None
    uptime_seconds: Optional[int] = None
    heartbeat_latency_ms: Optional[int] = None
    processes: Optional[List[Dict[str, Any]]] = None
    services: Optional[List[Dict[str, Any]]] = None
    software: Optional[List[Dict[str, Any]]] = None
    patch_status: Optional[Dict[str, Any]] = None
    # Windows security posture (agents >= 2.1.31), sent when it changed or
    # every six hours. Validated by app.schemas.security_posture when stored;
    # anything that is not an object is dropped here so it never fails the
    # heartbeat.
    security_posture: Optional[Dict[str, Any]] = None
    # Device health (agents >= 2.1.33): physical disks, pending restart and
    # critical System events, hourly, sent when changed or every six hours.
    # Validated by app.schemas.device_health when stored.
    device_health: Optional[Dict[str, Any]] = None
    agent_version: Optional[str] = None
    agent_sha256: Optional[str] = None

    @field_validator("security_posture", "device_health", mode="before")
    @classmethod
    def _posture_object_only(cls, value: Any) -> Any:
        return value if isinstance(value, dict) else None


class DeviceHeartbeatCreate(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    device_id: int
    rustdesk_id: Optional[str] = None
    hostname: Optional[str] = None
    current_user: Optional[str] = None
    domain: Optional[str] = None
    public_ip: Optional[str] = None
    local_ip: Optional[str] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    os_caption: Optional[str] = None
    os_build: Optional[str] = None
    windows_product_type: Optional[int] = None
    platform: Optional[str] = None
    device_type: DeviceType
    status: DeviceStatus
    cpu: Optional[str] = None
    ram: Optional[str] = None
    storage: Optional[str] = None
    rustdesk_install_status: Optional[str] = None
    rustdesk_status: Optional[str] = None
    rustdesk_version: Optional[str] = None
    rustdesk_install_path: Optional[str] = None


class AgentUpdateInfo(BaseModel):
    available: bool
    version: Optional[str] = None
    download_url: Optional[str] = None
    sha256: Optional[str] = None


class AgentHeartbeatResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    device_id: int
    heartbeat_id: int
    rustdesk_id: Optional[str] = None
    device_type: DeviceType
    status: DeviceStatus
    last_seen: Optional[datetime]
    heartbeat_at: datetime
    pending_actions: List[PendingActionDelivery] = []
    heartbeat_interval_seconds: Optional[int] = None
    agent_update: Optional[AgentUpdateInfo] = None
    # Per-device TECHI Remote Support password the agent must apply to RustDesk
    # (>= 2.1.5). Replaces the fleet-wide default. Sent every heartbeat so a
    # wiped RS config self-heals to the server-authoritative value.
    remote_support_password: Optional[str] = None
    # What the agent collects and the monitors it evaluates (>= 2.1.29). Sent
    # to an agent that proves its identity; older agents ignore it.
    monitoring_policy: Optional[dict] = None


class AgentPowerEventPayload(BaseModel):
    device_id: int
    agent_id: str
    state: Literal["shutdown", "sleep"]


class AgentEnrollmentRequest(BaseModel):
    agent_id: Optional[str] = None
    enrollment_token: Optional[str] = None  # optional for trusted domain auto-enrollment
    domain: Optional[str] = None
    hostname: Optional[str] = None
    current_user: Optional[str] = None
    platform: Optional[str] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    os_caption: Optional[str] = None
    os_build: Optional[str] = None
    windows_product_type: Optional[int] = None
    architecture: Optional[str] = None  # e.g. MikroTik chr/x86/arm/… (validated per platform)
    local_ip: Optional[str] = None
    public_ip: Optional[str] = None
    rustdesk_id: Optional[str] = None
    agent_version: Optional[str] = None
    agent_sha256: Optional[str] = None


class AgentEnrollmentResponse(BaseModel):
    agent_id: str
    device_id: int
    heartbeat_url: str
    websocket_url: str
    enrollment_status: str
    assigned_client_id: Optional[int] = None
    assigned_group_id: Optional[int] = None
