from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, ConfigDict


class TelemetrySnapshot(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: int
    cpu_percent: Optional[float] = None
    ram_percent: Optional[float] = None
    disk_percent: Optional[float] = None
    uptime_seconds: Optional[int] = None
    heartbeat_latency_ms: Optional[int] = None
    created_at: datetime


class DeviceHealth(BaseModel):
    device_id: int
    health_score: int
    health_state: str
    latest_telemetry: Optional[TelemetrySnapshot] = None
    reasons: List[str] = []


class DeviceHealthSummary(BaseModel):
    device_id: int
    health_score: int
    health_state: str
    cpu_percent: Optional[float] = None
    ram_percent: Optional[float] = None
    disk_percent: Optional[float] = None
    uptime_seconds: Optional[int] = None
    heartbeat_latency_ms: Optional[int] = None
    computed_at: Optional[datetime] = None
