from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel

TileState = Literal["ok", "running", "done", "warn", "down", "unknown"]


class WorkerItem(BaseModel):
    name: str
    state: Literal["ok", "down"]


class ServiceTile(BaseModel):
    key: str
    state: TileState
    label: str
    detail: str
    sub: Optional[str] = None
    at: Optional[datetime] = None
    value: Optional[float] = None
    total: Optional[int] = None
    items: Optional[List[WorkerItem]] = None


class SystemStatus(BaseModel):
    checked_at: datetime
    services: List[ServiceTile]
