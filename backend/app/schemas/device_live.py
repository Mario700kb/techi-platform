"""A live snapshot an agent streams while an operator has its device open.

The agent sends one every few seconds over its command channel; the backend
checks it against this shape and forwards it to the open device pages. Nothing
is stored. Unknown fields are dropped and every list and string is bounded, so
a frame cannot carry more than the page shows.
"""
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class LiveDisk(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mount: str = Field(max_length=64)
    used_percent: float = Field(ge=0, le=100)
    free_gb: float = Field(ge=0)
    total_gb: float = Field(ge=0)


class LiveProcess(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pid: int = Field(ge=0)
    name: str = Field(max_length=128)
    cpu_percent: float = Field(ge=0)
    memory_mb: float = Field(ge=0)


class LiveSnapshot(BaseModel):
    model_config = ConfigDict(extra="ignore")

    at: Optional[int] = None  # agent clock, unix milliseconds
    cpu_percent: Optional[float] = Field(default=None, ge=0, le=100)
    ram_percent: Optional[float] = Field(default=None, ge=0, le=100)
    ram_used_mb: Optional[float] = Field(default=None, ge=0)
    ram_total_mb: Optional[float] = Field(default=None, ge=0)
    disks: List[LiveDisk] = Field(default_factory=list, max_length=26)
    net_rx_kbps: Optional[float] = Field(default=None, ge=0)
    net_tx_kbps: Optional[float] = Field(default=None, ge=0)
    uptime_seconds: Optional[int] = Field(default=None, ge=0)
    current_user: Optional[str] = Field(default=None, max_length=256)
    user_session_state: Optional[str] = Field(default=None, max_length=32)
    remote_session_active: Optional[bool] = None
    process_count: Optional[int] = Field(default=None, ge=0)
    processes: List[LiveProcess] = Field(default_factory=list, max_length=15)
