from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


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
    rustdesk_id: Optional[str] = None
    hostname: Optional[str]
    current_user: Optional[str]
    domain: Optional[str]
    public_ip: Optional[str]
    local_ip: Optional[str]
    os_name: Optional[str]
    os_version: Optional[str]
    platform: Optional[str]
    device_type: DeviceType = DeviceType.UNASSIGNED
    status: DeviceStatus = DeviceStatus.OFFLINE
    last_seen: Optional[datetime] = None
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
    auto_assigned: bool = False
    assignment_source: str = "manual"
    is_archived: bool = False
    archived_at: Optional[datetime] = None
    archived_by: Optional[str] = None
    duplicate_candidate: bool = False
    duplicate_of_device_id: Optional[int] = None
    duplicate_score: Optional[float] = None
    is_in_maintenance: bool = False
    maintenance_started_at: Optional[datetime] = None
    maintenance_ends_at: Optional[datetime] = None
    maintenance_note: Optional[str] = None
    maintenance_started_by: Optional[str] = None


class DeviceCreate(DeviceBase):
    client_id: Optional[int] = None
    group_id: Optional[int] = None


class DeviceUpdate(BaseModel):
    hostname: Optional[str] = None
    current_user: Optional[str] = None
    domain: Optional[str] = None
    public_ip: Optional[str] = None
    local_ip: Optional[str] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    platform: Optional[str] = None
    device_type: Optional[DeviceType] = None
    status: Optional[DeviceStatus] = None
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    cpu: Optional[str] = None
    ram: Optional[str] = None
    storage: Optional[str] = None
    last_seen: Optional[datetime] = None
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
    freshness_state: DeviceFreshnessState = DeviceFreshnessState.OFFLINE


class DeviceClientAssignment(BaseModel):
    client_id: Optional[int] = None


class DeviceGroupAssignment(BaseModel):
    group_id: Optional[int] = None


class MaintenanceEnterRequest(BaseModel):
    duration_minutes: Optional[int] = None  # None = indefinite
    note: Optional[str] = None
    started_by: Optional[str] = None
