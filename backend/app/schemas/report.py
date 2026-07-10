from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.report import ReportCadence, ReportFormat, ReportRunStatus


class ReportGenerateRequest(BaseModel):
    client_id: int = Field(gt=0)
    report_format: ReportFormat = ReportFormat.PDF
    period_days: int = Field(default=30, ge=1, le=366)


class ReportScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    client_id: int = Field(gt=0)
    report_format: ReportFormat = ReportFormat.PDF
    cadence: ReportCadence = ReportCadence.MONTHLY
    period_days: int = Field(default=30, ge=1, le=366)
    hour_utc: int = Field(default=6, ge=0, le=23)
    day_of_week: Optional[int] = Field(default=None, ge=0, le=6)
    day_of_month: Optional[int] = Field(default=None, ge=1, le=28)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_cadence_fields(self):
        if self.cadence == ReportCadence.WEEKLY and self.day_of_week is None:
            raise ValueError("day_of_week is required for weekly schedules")
        if self.cadence == ReportCadence.MONTHLY and self.day_of_month is None:
            raise ValueError("day_of_month is required for monthly schedules")
        return self


class ReportScheduleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    report_format: Optional[ReportFormat] = None
    cadence: Optional[ReportCadence] = None
    period_days: Optional[int] = Field(default=None, ge=1, le=366)
    hour_utc: Optional[int] = Field(default=None, ge=0, le=23)
    day_of_week: Optional[int] = Field(default=None, ge=0, le=6)
    day_of_month: Optional[int] = Field(default=None, ge=1, le=28)
    enabled: Optional[bool] = None


class ReportScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    client_id: int
    client_name: str
    report_format: str
    cadence: str
    period_days: int
    hour_utc: int
    day_of_week: Optional[int]
    day_of_month: Optional[int]
    enabled: bool
    next_run_at: datetime
    last_run_at: Optional[datetime]
    created_by: str
    created_at: datetime
    updated_at: datetime


class ReportRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    schedule_id: Optional[int]
    client_id: int
    client_name: str
    report_format: str
    period_start: datetime
    period_end: datetime
    status: ReportRunStatus
    filename: Optional[str]
    size_bytes: Optional[int]
    error_message: Optional[str]
    generated_by: str
    created_at: datetime
    completed_at: Optional[datetime]


class ReportRunList(BaseModel):
    items: List[ReportRunOut]
    total: int
