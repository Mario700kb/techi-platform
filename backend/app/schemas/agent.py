from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.schemas.device import DeviceStatus, DeviceType


class AgentHeartbeatPayload(BaseModel):
    rustdesk_id: str
    hostname: Optional[str] = None
    current_user: Optional[str] = None
    domain: Optional[str] = None
    public_ip: Optional[str] = None
    local_ip: Optional[str] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    platform: Optional[str] = None
    cpu: Optional[str] = None
    ram: Optional[str] = None
    storage: Optional[str] = None
    client_id: Optional[int] = None
    group_id: Optional[int] = None

    class Config:
        orm_mode = True


class DeviceHeartbeatCreate(BaseModel):
    device_id: int
    rustdesk_id: str
    hostname: Optional[str] = None
    current_user: Optional[str] = None
    domain: Optional[str] = None
    public_ip: Optional[str] = None
    local_ip: Optional[str] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    platform: Optional[str] = None
    device_type: DeviceType
    status: DeviceStatus
    cpu: Optional[str] = None
    ram: Optional[str] = None
    storage: Optional[str] = None

    class Config:
        orm_mode = True


class AgentHeartbeatResponse(BaseModel):
    device_id: int
    heartbeat_id: int
    rustdesk_id: str
    device_type: DeviceType
    status: DeviceStatus
    last_seen: Optional[datetime]
    heartbeat_at: datetime

    class Config:
        orm_mode = True
