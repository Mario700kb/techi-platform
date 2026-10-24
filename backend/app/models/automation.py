"""Automation: tasks the platform runs on a schedule, in waves.

The first kind is the agent update: at the scheduled time the platform takes
the online devices of the task's scope that are not on the active agent and
updates them in waves (e.g. 10, 50, 200, then the rest), waiting between
waves and stopping the run when too many of a wave fail. Each wave is an
ordinary bulk command batch, so its devices show their progress as any
"Update agent" does.
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, String, Text

from app.core.time import utcnow_naive
from app.db.base import Base


class AutomationTask(Base):
    __tablename__ = "automation_tasks"

    id = Column(Integer, primary_key=True)
    name = Column(String(160), nullable=False)
    kind = Column(String(32), nullable=False, default="agent_update")
    enabled = Column(Boolean, nullable=False, default=True)

    # Which devices: default (all), client, group, device_type (category) or
    # devices (device_ids). Excluded clients and devices are never taken.
    scope = Column(String(16), nullable=False, default="default")
    scope_value = Column(String(64), nullable=True)
    device_ids = Column(JSON, nullable=True)
    excluded_client_ids = Column(JSON, nullable=True)
    excluded_device_ids = Column(JSON, nullable=True)
    skip_maintenance = Column(Boolean, nullable=False, default=True)

    # When, in the operators' timezone: once (run_at, naive UTC), daily,
    # weekly (weekday 0 = Monday) or monthly (day 1–28), at time_of_day.
    schedule = Column(String(16), nullable=False, default="once")
    run_at = Column(DateTime, nullable=True)
    time_of_day = Column(String(5), nullable=True)  # "HH:MM"
    weekday = Column(Integer, nullable=True)
    day_of_month = Column(Integer, nullable=True)
    # A run starts new waves only this long after it started.
    window_minutes = Column(Integer, nullable=False, default=240)

    # Waves: sizes in order, 0 = everything left; wait after a wave settles;
    # stop when more than this share of a wave failed.
    wave_sizes = Column(JSON, nullable=False, default=lambda: [10, 50, 200, 0])
    wave_wait_minutes = Column(Integer, nullable=False, default=30)
    max_failure_percent = Column(Integer, nullable=False, default=5)

    next_run_at = Column(DateTime, nullable=True, index=True)
    last_run_at = Column(DateTime, nullable=True)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)
    updated_at = Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False)


class AutomationRun(Base):
    __tablename__ = "automation_runs"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("automation_tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    # running → completed | halted | cancelled | window_closed
    status = Column(String(16), nullable=False, default="running", index=True)
    trigger = Column(String(16), nullable=False, default="schedule")  # schedule | manual
    started_by = Column(String(128), nullable=True)
    started_at = Column(DateTime, default=utcnow_naive, nullable=False)
    finished_at = Column(DateTime, nullable=True)
    next_wave_at = Column(DateTime, nullable=True)
    # [{"wave": 1, "batch_id": "...", "device_ids": [...], "started_at": iso,
    #   "settled_at": iso|None, "completed": n, "failed": n, "unfinished": n}]
    waves = Column(JSON, nullable=False, default=list)
    reason = Column(Text, nullable=True)
