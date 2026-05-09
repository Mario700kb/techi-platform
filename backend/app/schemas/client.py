from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ClientBase(BaseModel):
    name: str
    description: Optional[str] = None
    is_active: bool = True


class Client(ClientBase):
    id: int
    created_at: datetime

    class Config:
        orm_mode = True
