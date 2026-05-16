from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class DeviceGroupBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    client_id: int
    description: Optional[str] = None


class DeviceGroupCreate(DeviceGroupBase):
    pass


class DeviceGroupUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = None


class DeviceGroupDuplicateCleanupRequest(BaseModel):
    client_id: Optional[int] = None
    merge_target_group_id: Optional[int] = None


class DeviceGroupDuplicateCleanupResult(BaseModel):
    deleted_group_ids: List[int]
    merged_group_ids: List[int]
    detached_device_count: int = 0
    message: str


class DeviceGroup(DeviceGroupBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
