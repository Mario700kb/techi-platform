from datetime import datetime, timedelta, timezone
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.report import ReportCadence, ReportFormat, ReportRunStatus


class ReportGenerateRequest(BaseModel):
    scope_type: str = "client"
    client_id: Optional[int] = Field(default=None, gt=0)
    device_id: Optional[int] = Field(default=None, gt=0)
    report_type: str = "full"
    report_format: ReportFormat = ReportFormat.PDF
    period_days: int = Field(default=30, ge=1, le=366)
    period_from: Optional[datetime] = None
    period_to: Optional[datetime] = None

    @model_validator(mode="after")
    def validate_scope_and_period(self):
        device_types = {"full", "overview", "user_activity", "status_uptime", "health", "alerts", "actions", "software", "remote_support", "assignments", "notes", "event_history"}
        if self.scope_type == "client":
            if self.client_id is None or self.device_id is not None or self.report_type != "full":
                raise ValueError("Client reports require client_id and Full Report")
        elif self.scope_type == "device":
            if self.device_id is None or self.client_id is not None or self.report_type not in device_types:
                raise ValueError("Device report scope, target or type is invalid")
            if self.report_type == "full" and self.report_format == ReportFormat.CSV:
                raise ValueError("Full Device Report is PDF only")
        else:
            raise ValueError("Invalid report scope")
        if (self.period_from is None) != (self.period_to is None):
            raise ValueError("Both custom range endpoints are required")
        if self.period_from is not None:
            start = self.period_from.replace(tzinfo=timezone.utc) if self.period_from.tzinfo is None else self.period_from.astimezone(timezone.utc)
            end = self.period_to.replace(tzinfo=timezone.utc) if self.period_to.tzinfo is None else self.period_to.astimezone(timezone.utc)
            if start >= end or end - start > timedelta(days=366) or end > datetime.now(timezone.utc) + timedelta(minutes=5):
                raise ValueError("Invalid custom report range")
            self.period_from = start
            self.period_to = end
        return self


class ReportScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    client_id: int = Field(gt=0)
    report_format: ReportFormat = ReportFormat.PDF
    cadence: ReportCadence = ReportCadence.MONTHLY
    period_days: int = Field(default=30, ge=1, le=366)
    hour_local: int = Field(default=6, ge=0, le=23)
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
    hour_local: Optional[int] = Field(default=None, ge=0, le=23)
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
    hour_local: int
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
    client_id: Optional[int]
    client_name: str
    scope_type: str = "client"
    device_id: Optional[int] = None
    device_name: Optional[str] = None
    report_type: str = "full"
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
