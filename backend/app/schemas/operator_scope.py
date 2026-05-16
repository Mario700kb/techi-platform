from datetime import datetime
from typing import List

from pydantic import BaseModel, ConfigDict

from app.models.operator_scope import ScopeType


class ScopeEntryCreate(BaseModel):
    scope_type: ScopeType
    scope_id: int


class ScopeEntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    operator_id: int
    scope_type: str
    scope_id: int
    created_at: datetime


class ScopeReplaceRequest(BaseModel):
    entries: List[ScopeEntryCreate]
