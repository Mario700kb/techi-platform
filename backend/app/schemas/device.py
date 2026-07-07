from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DeviceType(str, Enum):
    SERVER = "server"
    CLIENT = "client"
    UNASSIGNED = "unassigned"


class DeviceStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"


class DeviceFreshnessState(str, Enum):
    ONLINE = "online"
    STALE = "stale"
    OFFLINE = "offline"


class DeviceBase(BaseModel):
    agent_id: Optional[str] = None
    rustdesk_id: Optional[str] = None
    hostname: Optional[str]
    display_name: Optional[str] = Field(default=None, max_length=128)
    current_user: Optional[str]
    user_source: Optional[str] = None
    user_session_state: Optional[str] = None
    domain: Optional[str]
    public_ip: Optional[str]
    local_ip: Optional[str]
    os_name: Optional[str]
    os_version: Optional[str]
    os_caption: Optional[str] = None
    os_build: Optional[str] = None
    windows_product_type: Optional[int] = None
    platform: Optional[str]
    fqdn: Optional[str] = None
    kernel_version: Optional[str] = None
    architecture: Optional[str] = None
    mac_address: Optional[str] = None
    timezone: Optional[str] = None
    last_boot_at: Optional[datetime] = None
    device_type: DeviceType = DeviceType.UNASSIGNED
    status: DeviceStatus = DeviceStatus.OFFLINE
    last_seen: Optional[datetime] = None
    last_enrollment_at: Optional[datetime] = None
    enrollment_count: int = 0
    reenrolled_from_agent_id: Optional[str] = None
    cpu: Optional[str]
    ram: Optional[str]
    storage: Optional[str]
    rustdesk_install_status: str = "unknown"
    rustdesk_status: str = "unknown"
    rustdesk_version: Optional[str] = None
    rustdesk_install_path: Optional[str] = None
    rustdesk_last_seen_at: Optional[datetime] = None
    rustdesk_synced_at: Optional[datetime] = None
    rustdesk_sync_state: str = "unknown"
    rustdesk_sync_message: Optional[str] = None
    rustdesk_verified_at: Optional[datetime] = None
    rustdesk_manual_override: bool = False
    rustdesk_conflict_detected: bool = False
    rustdesk_last_repair_at: Optional[datetime] = None
    rustdesk_repair_count: int = 0
    auto_assigned: bool = False
    assignment_source: str = "manual"
    is_archived: bool = False
    archived_at: Optional[datetime] = None
    archived_by: Optional[str] = None
    duplicate_candidate: bool = False
    duplicate_of_device_id: Optional[int] = None
    duplicate_score: Optional[float] = None
    # Offline reason engine
    offline_reason: Optional[str] = None
    offline_confidence: Optional[str] = None
    last_boot_time: Optional[datetime] = None
    last_shutdown_time: Optional[datetime] = None
    network_disconnect_time: Optional[datetime] = None
    is_in_maintenance: bool = False
    maintenance_started_at: Optional[datetime] = None
    maintenance_ends_at: Optional[datetime] = None
    maintenance_note: Optional[str] = None
    maintenance_started_by: Optional[str] = None
    agent_version: Optional[str] = None
    agent_sha256: Optional[str] = None


class DeviceCreate(DeviceBase):
    client_id: Optional[int] = None
    group_id: Optional[int] = None


class DeviceUpdate(BaseModel):
    agent_id: Optional[str] = None
    hostname: Optional[str] = None
    display_name: Optional[str] = Field(default=None, max_length=128)
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
    fqdn: Optional[str] = None
    kernel_version: Optional[str] = None
    architecture: Optional[str] = None
    mac_address: Optional[str] = None
    timezone: Optional[str] = None
    last_boot_at: Optional[datetime] = None
    device_type: Optional[DeviceType] = None
    status: Optional[DeviceStatus] = None
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    cpu: Optional[str] = None
    ram: Optional[str] = None
    storage: Optional[str] = None
    last_seen: Optional[datetime] = None
    last_enrollment_at: Optional[datetime] = None
    enrollment_count: Optional[int] = None
    reenrolled_from_agent_id: Optional[str] = None
    rustdesk_id: Optional[str] = None
    rustdesk_install_status: Optional[str] = None
    rustdesk_status: Optional[str] = None
    rustdesk_version: Optional[str] = None
    rustdesk_install_path: Optional[str] = None
    rustdesk_last_seen_at: Optional[datetime] = None
    rustdesk_synced_at: Optional[datetime] = None
    rustdesk_sync_state: Optional[str] = None
    rustdesk_sync_message: Optional[str] = None
    rustdesk_verified_at: Optional[datetime] = None
    rustdesk_manual_override: Optional[bool] = None
    rustdesk_conflict_detected: Optional[bool] = None
    rustdesk_last_repair_at: Optional[datetime] = None
    rustdesk_repair_count: Optional[int] = None
    auto_assigned: Optional[bool] = None
    assignment_source: Optional[str] = None
    is_archived: Optional[bool] = None
    archived_at: Optional[datetime] = None
    archived_by: Optional[str] = None
    duplicate_candidate: Optional[bool] = None
    duplicate_of_device_id: Optional[int] = None
    duplicate_score: Optional[float] = None
    is_in_maintenance: Optional[bool] = None
    maintenance_started_at: Optional[datetime] = None
    maintenance_ends_at: Optional[datetime] = None
    maintenance_note: Optional[str] = None
    maintenance_started_by: Optional[str] = None
    agent_version: Optional[str] = None
    agent_sha256: Optional[str] = None

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None


class RustDeskIdVerifyRequest(BaseModel):
    rustdesk_id: str


class RustDeskIdVerifyResponse(BaseModel):
    valid: bool
    normalized_rustdesk_id: Optional[str] = None
    message: Optional[str] = None
    conflict_device_id: Optional[int] = None


class RustDeskManualOverrideRequest(BaseModel):
    rustdesk_id: str
    reason: Optional[str] = None


class RustDeskHealth(BaseModel):
    device_id: int
    rustdesk_id: str
    install_status: str
    status: str
    version: Optional[str] = None
    install_path: Optional[str] = None
    sync_state: str
    sync_message: Optional[str] = None
    last_update: Optional[datetime] = None
    verified_at: Optional[datetime] = None
    manual_override: bool
    conflict_detected: bool


class Device(DeviceBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    registered_at: datetime
    last_seen: Optional[datetime]
    client_id: Optional[int]
    group_id: Optional[int]
    client_name: Optional[str] = None
    group_name: Optional[str] = None
    resolved_client_id: Optional[int] = None
    resolved_client_name: Optional[str] = None
    resolved_group: Optional[str] = None
    resolved_assignment_source: str = "unassigned"
    resolved_device_category: str = "unassigned"
    freshness_state: DeviceFreshnessState = DeviceFreshnessState.OFFLINE


class DeviceStats(BaseModel):
    total: int
    online: int
    stale: int
    offline: int


class DeviceTreeCounts(BaseModel):
    total: int
    unassigned: int
    by_client: Dict[int, int]
    by_client_category: Dict[int, Dict[str, int]] = Field(default_factory=dict)


class DevicesSummary(BaseModel):
    devices: List[Device]
    stats: DeviceStats
    health: List["DeviceHealthSummary"]
    patches: List["PatchStatusSnapshot"]
    tree_counts: DeviceTreeCounts
    loaded_at: datetime


class DeviceFleetOverview(BaseModel):
    stats: DeviceStats
    tree_counts: DeviceTreeCounts
    critical: int
    warnings: int
    average_health: Optional[int] = None
    needs_updates: int
    agents_outdated: int = 0
    active_agent_version: Optional[str] = None
    active_agent_sha256: Optional[str] = None
    loaded_at: datetime


class DeviceTableDetails(BaseModel):
    health: List["DeviceHealthSummary"]
    patches: List["PatchStatusSnapshot"]


class DeviceListResponse(BaseModel):
    devices: List[Device]
    total: int


class DeviceClientAssignment(BaseModel):
    client_id: Optional[int] = None


class DeviceGroupAssignment(BaseModel):
    group_id: Optional[int] = None


class MaintenanceEnterRequest(BaseModel):
    duration_minutes: Optional[int] = None  # None = indefinite
    note: Optional[str] = None
    started_by: Optional[str] = None


from app.schemas.device_inventory import PatchStatusSnapshot
from app.schemas.telemetry import DeviceHealthSummary

DevicesSummary.model_rebuild()
DeviceTableDetails.model_rebuild()
