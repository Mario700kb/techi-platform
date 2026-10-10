from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel


class AvailabilityPoint(BaseModel):
    date: str
    availability_pct: Optional[float]


class AvailabilityTrend(BaseModel):
    days: int
    series: List[AvailabilityPoint]
    overall_pct: Optional[float]
    coverage_pct: Optional[float]
    device_count: int


class AlertTrendPoint(BaseModel):
    date: str
    opened: int
    resolved: int


class AlertTrend(BaseModel):
    days: int
    series: List[AlertTrendPoint]
    opened_total: int
    resolved_total: int
    open_now: int
    mean_time_to_resolve_hours: Optional[float]


class ProblemDevice(BaseModel):
    device_id: int
    name: str
    client_name: Optional[str]
    offline_events: int
    alerts: int
    freshness_state: str


class FleetInsights(BaseModel):
    availability: AvailabilityTrend
    alerts: AlertTrend
    problem_devices: List[ProblemDevice]
    generated_at: datetime
