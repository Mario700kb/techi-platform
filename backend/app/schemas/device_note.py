from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class DeviceNoteCreate(BaseModel):
    note: str = Field(min_length=1, max_length=5000)
    created_by: Optional[str] = Field(default=None, max_length=128)


class DeviceNoteUpdate(BaseModel):
    note: str = Field(min_length=1, max_length=5000)


class DeviceNoteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: int
    note: str
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

