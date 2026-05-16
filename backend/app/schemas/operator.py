from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr

from app.models.operator import OperatorRole


class OperatorBase(BaseModel):
    username: str
    email: EmailStr
    display_name: Optional[str] = None


class OperatorCreate(OperatorBase):
    password: str
    role: OperatorRole = OperatorRole.READONLY


class OperatorUpdate(BaseModel):
    username: Optional[str] = None
    email: Optional[EmailStr] = None
    display_name: Optional[str] = None
    role: Optional[OperatorRole] = None
    is_active: Optional[bool] = None


class OperatorPasswordReset(BaseModel):
    new_password: str


class Operator(OperatorBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    is_active: bool
    is_superuser: bool
    role: OperatorRole
    created_at: datetime
    last_login_at: Optional[datetime] = None
    last_active_at: Optional[datetime] = None
