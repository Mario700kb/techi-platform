from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: int
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


class AlertCountResponse(BaseModel):
    total_open: int
    by_severity: Dict[str, int]
