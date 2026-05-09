from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr


class OperatorBase(BaseModel):
    username: str
    email: EmailStr


class OperatorCreate(OperatorBase):
    password: str


class Operator(OperatorBase):
    id: int
    is_active: bool
    is_superuser: bool
    created_at: datetime

    class Config:
        orm_mode = True
