from enum import Enum

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Integer, String, Text

from app.core.time import utcnow
from app.db.base import Base


class ReportFormat(str, Enum):
    PDF = "pdf"
    CSV = "csv"


class ReportCadence(str, Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class ReportRunStatus(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"


class ReportSchedule(Base):
    __tablename__ = "report_schedules"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(160), nullable=False)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    report_format = Column(String(8), nullable=False, default=ReportFormat.PDF.value)
    cadence = Column(String(16), nullable=False, default=ReportCadence.MONTHLY.value)
    period_days = Column(Integer, nullable=False, default=30)
    hour_utc = Column(Integer, nullable=False, default=6)
    day_of_week = Column(Integer, nullable=True)
    day_of_month = Column(Integer, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True, index=True)
    next_run_at = Column(DateTime, nullable=False, index=True)
    last_run_at = Column(DateTime, nullable=True)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class ReportRun(Base):
    __tablename__ = "report_runs"
    __table_args__ = (
        CheckConstraint("scope_type IN ('client', 'device')", name="ck_report_runs_scope_type"),
        CheckConstraint("(scope_type = 'client' AND client_id IS NOT NULL AND device_id IS NULL) OR (scope_type = 'device' AND device_id IS NOT NULL)", name="ck_report_runs_target"),
    )

    id = Column(Integer, primary_key=True, index=True)
    schedule_id = Column(Integer, ForeignKey("report_schedules.id", ondelete="SET NULL"), nullable=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=True, index=True)
    client_name = Column(String(160), nullable=False)
    scope_type = Column(String(16), nullable=False, default="client", server_default="client")
    device_id = Column(Integer, nullable=True)
    device_name = Column(String(160), nullable=True)
    group_id = Column(Integer, nullable=True)
    report_type = Column(String(32), nullable=False, default="full", server_default="full")
    report_format = Column(String(8), nullable=False)
    period_start = Column(DateTime, nullable=False)
    period_end = Column(DateTime, nullable=False)
    status = Column(String(16), nullable=False, default=ReportRunStatus.PENDING.value, index=True)
    filename = Column(String(255), nullable=True)
    storage_path = Column(Text, nullable=True)
    size_bytes = Column(Integer, nullable=True)
    error_message = Column(String(1024), nullable=True)
    generated_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False, index=True)
    completed_at = Column(DateTime, nullable=True)
