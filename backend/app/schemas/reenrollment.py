from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class ReenrollmentRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: int
    device_hostname: Optional[str] = None
    new_device_id: Optional[int] = None
    agent_id: str
    matched_by: str
    status: str
    hostname: Optional[str] = None
    current_user: Optional[str] = None
    domain: Optional[str] = None
    local_ip: Optional[str] = None
    public_ip: Optional[str] = None
    rustdesk_id: Optional[str] = None
    os_caption: Optional[str] = None
    platform: Optional[str] = None
    token_name: Optional[str] = None
    created_at: datetime
    last_seen_at: Optional[datetime] = None
    decided_at: Optional[datetime] = None
    decided_by: Optional[str] = None
    decision: Optional[str] = None
