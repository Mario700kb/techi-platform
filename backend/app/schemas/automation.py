import re
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.time import ensure_utc

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class AutomationTaskBody(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    enabled: bool = True
    scope: Literal["default", "client", "group", "device_type", "devices"] = "default"
    scope_value: Optional[str] = Field(default=None, max_length=64)
    device_ids: List[int] = Field(default_factory=list, max_length=5000)
    excluded_client_ids: List[int] = Field(default_factory=list, max_length=1000)
    excluded_device_ids: List[int] = Field(default_factory=list, max_length=5000)
    skip_maintenance: bool = True
    schedule: Literal["once", "daily", "weekly", "monthly"] = "once"
    run_at: Optional[datetime] = None
    time_of_day: Optional[str] = None
    weekday: Optional[int] = Field(default=None, ge=0, le=6)
    day_of_month: Optional[int] = Field(default=None, ge=1, le=28)
    window_minutes: int = Field(default=240, ge=15, le=1440)
    wave_sizes: List[int] = Field(default_factory=lambda: [10, 50, 200, 0], min_length=1, max_length=10)
    wave_wait_minutes: int = Field(default=30, ge=0, le=1440)
    max_failure_percent: int = Field(default=5, ge=0, le=100)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Give the task a name")
        return v

    @field_validator("wave_sizes")
    @classmethod
    def _waves(cls, v: List[int]) -> List[int]:
        if any(s < 0 or s > 5000 for s in v):
            raise ValueError("Each wave is 1–5000 devices, or 0 for everything left")
        if 0 in v[:-1]:
            raise ValueError("Only the last wave can be 'everything left' (0)")
        return v

    @model_validator(mode="after")
    def _consistent(self):
        if self.scope in ("client", "group", "device_type") and not (self.scope_value or "").strip():
            raise ValueError(f"Choose the {self.scope.replace('_', ' ')} this task is for")
        if self.scope == "devices" and not self.device_ids:
            raise ValueError("Choose at least one device")
        if self.schedule == "once":
            if self.run_at is None:
                raise ValueError("Choose when the task runs")
            self.run_at = ensure_utc(self.run_at).replace(tzinfo=None)
        else:
            if not self.time_of_day or not _HHMM.match(self.time_of_day):
                raise ValueError("Choose the time of day (HH:MM)")
            if self.schedule == "weekly" and self.weekday is None:
                raise ValueError("Choose the day of the week")
            if self.schedule == "monthly" and self.day_of_month is None:
                raise ValueError("Choose the day of the month")
        return self


class AutomationRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    task_id: int
    status: str
    trigger: str
    started_by: Optional[str] = None
    started_at: datetime
    finished_at: Optional[datetime] = None
    next_wave_at: Optional[datetime] = None
    waves: list = []
    reason: Optional[str] = None


class AutomationTaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    enabled: bool
    scope: str
    scope_value: Optional[str] = None
    device_ids: List[int] = []
    excluded_client_ids: List[int] = []
    excluded_device_ids: List[int] = []
    skip_maintenance: bool
    schedule: str
    run_at: Optional[datetime] = None
    time_of_day: Optional[str] = None
    weekday: Optional[int] = None
    day_of_month: Optional[int] = None
    window_minutes: int
    wave_sizes: List[int]
    wave_wait_minutes: int
    max_failure_percent: int
    next_run_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    created_by: str
    created_at: datetime
    last_run: Optional[AutomationRunOut] = None

    @field_validator("device_ids", "excluded_client_ids", "excluded_device_ids", mode="before")
    @classmethod
    def _none_list(cls, v):
        return v or []


class AutomationPreview(BaseModel):
    """What a run would do now."""

    needs_update: int
    up_to_date_or_busy: int
    first_wave: int
    version: Optional[str] = None
