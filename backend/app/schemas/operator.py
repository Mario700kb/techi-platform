from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.models.operator import OperatorRole


class OperatorBase(BaseModel):
    username: str
    email: EmailStr
    display_name: Optional[str] = None

    @field_validator("username")
    @classmethod
    def username_not_empty(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Username is required")
        return normalized

    @field_validator("display_name")
    @classmethod
    def display_name_not_blank(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class OperatorCreate(OperatorBase):
    password: str
    role: OperatorRole = OperatorRole.READONLY
    is_active: bool = True

    @field_validator("password")
    @classmethod
    def password_is_strong_enough(cls, value: str) -> str:
        if len(value) < 8:
            raise ValueError("Password must be at least 8 characters")
        if value.strip() != value or not value.strip():
            raise ValueError("Password cannot be empty or padded with spaces")
        return value


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
