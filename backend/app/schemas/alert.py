from datetime import datetime
from typing import Dict, Optional

from pydantic import BaseModel, ConfigDict


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: Optional[int] = None
    token_id: Optional[int] = None
    kind: str
    severity: str
    state: str
    message: str
    detail: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    resolved_at: Optional[datetime] = None
    acknowledged_at: Optional[datetime] = None
    cooldown_until: Optional[datetime] = None
    # The device's current name and client, so a list never fetches each
    # device separately and never shows the hostname frozen into `message`.
    device_name: Optional[str] = None
    client_name: Optional[str] = None


class AlertCountResponse(BaseModel):
    total_open: int
    by_severity: Dict[str, int]
    by_kind: Dict[str, int] = {}
    devices_affected: int = 0
    oldest_open_at: Optional[datetime] = None
