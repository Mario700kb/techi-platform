from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class EnrollmentTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    expires_at: Optional[datetime] = None
    max_uses: int = Field(default=1, ge=1, le=1000)
    client_id: Optional[int] = None
    group_id: Optional[int] = None


class EnrollmentTokenOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    status: str
    created_at: datetime
    expires_at: Optional[datetime]
    used_at: Optional[datetime]
    max_uses: int
    use_count: int
    client_id: Optional[int]
    group_id: Optional[int]
    is_default: bool = False
    token_prefix: Optional[str] = None


class EnrollmentTokenCreateResponse(EnrollmentTokenOut):
    token: str


class EnrollmentTokenVerifyRequest(BaseModel):
    token: str = Field(min_length=16)


class EnrollmentTokenVerifyResponse(BaseModel):
    valid: bool
    status: str
    token_id: Optional[int] = None
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    message: str
