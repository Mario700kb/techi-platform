from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    operator_id: Optional[int] = None
    operator_username: Optional[str] = None
    action: str
    entity_type: Optional[str] = None
    entity_id: Optional[int] = None
    details_json: Optional[str] = None
    created_at: datetime


class AuditLogPage(BaseModel):
    total: int
    items: List[AuditLogOut]
