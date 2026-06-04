from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict


class TeamCreate(BaseModel):
    name: str
    description: Optional[str] = None
    color: Optional[str] = None
    permissions: Optional[List[str]] = None


class TeamUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    permissions: Optional[List[str]] = None


class TeamResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: Optional[str] = None
    color: Optional[str] = None
    permissions: List[str] = []
    created_at: datetime


class TeamDetailResponse(TeamResponse):
    operator_ids: List[int] = []
    client_ids: List[int] = []
    group_ids: List[int] = []
    device_ids: List[int] = []


class TeamWithStats(TeamResponse):
    member_count: int = 0
    client_count: int = 0
    group_count: int = 0
    device_count: int = 0
    operator_ids: List[int] = []


class MemberUpdateRequest(BaseModel):
    operator_ids: List[int]


class AccessUpdateRequest(BaseModel):
    ids: List[int]


class TeamPermissionsUpdateRequest(BaseModel):
    permissions: List[str]
