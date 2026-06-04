from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ActivityEvent(BaseModel):
    id: str
    type: str
    occurred_at: datetime
    summary: str
    detail: Optional[str] = None
    actor: Optional[str] = None
    device_id: int
