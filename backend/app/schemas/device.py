from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel


class DeviceType(str, Enum):
    SERVER = "server"
    CLIENT = "client"
    UNASSIGNED = "unassigned"


class DeviceStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"


class DeviceBase(BaseModel):
    rustdesk_id: str
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
    cpu: Optional[str]
    ram: Optional[str]
    storage: Optional[str]


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


class Device(DeviceBase):
    id: int
    registered_at: datetime
    last_seen: Optional[datetime]
    client_id: Optional[int]
    group_id: Optional[int]

    class Config:
        from_attributes = True

