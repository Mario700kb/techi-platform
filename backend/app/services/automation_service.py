"""Automation: scheduled agent updates in waves (app/models/automation.py).

A sweep every minute (main.py) starts the tasks that came due and moves each
running run forward:

1. A wave is the next N eligible devices: online, in the task's scope, not
   excluded, not in maintenance (unless allowed), and needing the update
   (AgentCommandService.plan_self_update decides, as for "Update agent").
   It goes out as an ordinary bulk self_update batch, pushed live.
2. The wave settles when every action in it has ended, or after
   WAVE_SETTLE_MINUTES. Unfinished actions count as failed.
3. More than max_failure_percent failed: the run halts. Otherwise the next
   wave starts wave_wait_minutes later, while the run's window is open.
4. No eligible device left: the run is completed. Window closed first: the
   run ends as window_closed; the devices left wait for the next run.
"""
import logging
import random
from datetime import datetime, timedelta
from typing import List, Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.time import utcnow_naive
from app.models.automation import AutomationRun, AutomationTask
from app.models.device import Device, DeviceStatus
from app.models.remote_action import ActionStatus, RemoteAction, TERMINAL_STATUSES

logger = logging.getLogger(__name__)

WAVE_SETTLE_MINUTES = 30
RUNNING = "running"
FINAL_STATUSES = {"completed", "halted", "cancelled", "window_closed"}
FAILED_STATUSES = {ActionStatus.FAILED, ActionStatus.EXPIRED, ActionStatus.CANCELLED}


# ── schedule ────────────────────────────────────────────────────────────────

def _zone() -> ZoneInfo:
    return ZoneInfo(settings.DISPLAY_TIMEZONE)


def _hm(value: Optional[str]) -> tuple[int, int]:
    hour, minute = (value or "02:00").split(":")
    return int(hour), int(minute)


def next_run_after(task: AutomationTask, after: datetime) -> Optional[datetime]:
    """The next start strictly after `after` (naive UTC), in naive UTC; None
    for a one-off that has passed or an unknown schedule."""
    if task.schedule == "once":
        return task.run_at if task.run_at and task.run_at > after else None
    zone = _zone()
    local_after = after.replace(tzinfo=ZoneInfo("UTC")).astimezone(zone)
    hour, minute = _hm(task.time_of_day)
    day = local_after.date()
    for offset in range(0, 400):
        candidate_day = day + timedelta(days=offset)
        if task.schedule == "weekly" and candidate_day.weekday() != (task.weekday or 0):
            continue
        if task.schedule == "monthly" and candidate_day.day != (task.day_of_month or 1):
            continue
        if task.schedule not in ("daily", "weekly", "monthly"):
            return None
        local = datetime(candidate_day.year, candidate_day.month, candidate_day.day, hour, minute, tzinfo=zone)
        utc = local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
        if utc > after:
            return utc
    return None


# ── devices ─────────────────────────────────────────────────────────────────

def _in_scope(task: AutomationTask, device: Device) -> bool:
    from app.services.monitoring_policy_service import device_in_scope

    if task.scope == "devices":
        return device.id in set(task.device_ids or [])
    return device_in_scope(task.scope, task.scope_value, device)


def candidate_devices(db: Session, task: AutomationTask, *, attempted: Optional[set] = None) -> List[Device]:
    """Devices this task may update now, before the per-device update check."""
    excluded_clients = set(task.excluded_client_ids or [])
    excluded_devices = set(task.excluded_device_ids or [])
    attempted = attempted or set()
    rows = (
        db.query(Device)
        .filter(
            (Device.is_archived.is_(False)) | (Device.is_archived.is_(None)),
            Device.deleted_at.is_(None),
            Device.status == DeviceStatus.ONLINE,
        )
        .all()
    )
    out = []
    for device in rows:
        if device.id in attempted or device.id in excluded_devices or device.client_id in excluded_clients:
            continue
        if task.skip_maintenance and device.is_in_maintenance:
            continue
        if _in_scope(task, device):
            out.append(device)
    return out


def eligible_devices(db: Session, task: AutomationTask, *, attempted: Optional[set] = None) -> tuple[List[Device], int]:
    """(devices needing the update now, devices in scope already on it or busy)."""
    from app.services.agent_command_service import AgentCommandService

    candidates = candidate_devices(db, task, attempted=attempted)
    keep, skipped = AgentCommandService(db).plan_self_update(candidates)
    return keep, len(skipped)


# ── runs ────────────────────────────────────────────────────────────────────

class AutomationError(ValueError):
    pass


def active_run(db: Session, task_id: int) -> Optional[AutomationRun]:
    return (
        db.query(AutomationRun)
        .filter(AutomationRun.task_id == task_id, AutomationRun.status == RUNNING)
        .first()
    )


def start_run(db: Session, task: AutomationTask, *, trigger: str, started_by: Optional[str], now=None) -> AutomationRun:
    now = now or utcnow_naive()
    if active_run(db, task.id) is not None:
        raise AutomationError("This task already has a run in progress")
    run = AutomationRun(task_id=task.id, status=RUNNING, trigger=trigger, started_by=started_by,
                        started_at=now, next_wave_at=now, waves=[])
    db.add(run)
    task.last_run_at = now
    db.commit()
    db.refresh(run)
    logger.info("[automation] task #%d %r: run #%d started (%s)", task.id, task.name, run.id, trigger)
    return run


def cancel_run(db: Session, run: AutomationRun, *, now=None) -> AutomationRun:
    from app.services.agent_command_service import AgentCommandService

    if run.status != RUNNING:
        raise AutomationError("Only a run in progress can be stopped")
    waves = run.waves or []
    if waves and not waves[-1].get("settled_at"):
        try:
            AgentCommandService(db).cancel_batch(waves[-1]["batch_id"])
        except ValueError:
            pass
    _finish(run, "cancelled", "Stopped by an operator", now or utcnow_naive())
    db.commit()
    return run


def _finish(run: AutomationRun, status: str, reason: str, now: datetime) -> None:
    run.status = status
    run.reason = reason
    run.finished_at = now
    run.next_wave_at = None


def _wave_target(task: AutomationTask, wave_index: int) -> int:
    sizes = [int(s) for s in (task.wave_sizes or [0])]
    size = sizes[wave_index] if wave_index < len(sizes) else sizes[-1]
    return size  # 0 = everything left


def _settle(db: Session, run: AutomationRun, task: AutomationTask, now: datetime) -> bool:
    """Close the current wave if it has ended; False while it still runs."""
    waves = [dict(w) for w in (run.waves or [])]
    wave = waves[-1]
    actions = db.query(RemoteAction).filter(RemoteAction.batch_id == wave["batch_id"]).all()
    started = datetime.fromisoformat(wave["started_at"])
    still_running = [a for a in actions if a.status not in TERMINAL_STATUSES]
    if still_running and now < started + timedelta(minutes=WAVE_SETTLE_MINUTES):
        return False
    wave["completed"] = sum(1 for a in actions if a.status == ActionStatus.COMPLETED)
    wave["failed"] = sum(1 for a in actions if a.status in FAILED_STATUSES)
    wave["unfinished"] = len(still_running)
    wave["settled_at"] = now.isoformat()
    run.waves = waves
    total = max(len(actions), 1)
    bad = wave["failed"] + wave["unfinished"]
    if bad * 100 > task.max_failure_percent * total:
        _finish(run, "halted",
                f"Wave {wave['wave']}: {bad} of {len(actions)} did not update (limit {task.max_failure_percent}%)", now)
        logger.warning("[automation] run #%d halted: %s", run.id, run.reason)
    else:
        run.next_wave_at = now + timedelta(minutes=task.wave_wait_minutes)
    return True


def _start_wave(db: Session, run: AutomationRun, task: AutomationTask, now: datetime) -> None:
    from app.schemas.agent_command import BulkCommandCreate, BulkCommandTarget
    from app.services.agent_command_service import AgentCommandService

    if now >= run.started_at + timedelta(minutes=task.window_minutes):
        _finish(run, "window_closed", "The run's time window closed; devices left wait for the next run", now)
        return
    attempted = {i for w in (run.waves or []) for i in w.get("device_ids", [])}
    keep, _ = eligible_devices(db, task, attempted=attempted)
    if not keep:
        _finish(run, "completed", "No device left to update", now)
        return
    random.Random(run.id * 1000 + len(run.waves or [])).shuffle(keep)
    size = _wave_target(task, len(run.waves or []))
    chosen = keep if size <= 0 else keep[:size]
    try:
        result = AgentCommandService(db).create_bulk(
            create_in=BulkCommandCreate(
                command_type="self_update", target=BulkCommandTarget.DEVICES,
                device_ids=[d.id for d in chosen], timeout_seconds=600,
            ),
            operator_id=None,
            operator_username=f"automation: {task.name}"[:128],
        )
    except ValueError as exc:  # nothing to update after all
        _finish(run, "completed", str(exc), now)
        return
    number = len(run.waves or []) + 1
    run.waves = [*(run.waves or []), {
        "wave": number, "batch_id": result.batch_id, "device_ids": [d.id for d in chosen],
        "started_at": now.isoformat(), "settled_at": None, "completed": 0, "failed": 0, "unfinished": 0,
    }]
    run.next_wave_at = None
    logger.info("[automation] run #%d: wave %d with %d device(s), batch %s, %d pushed live",
                run.id, number, len(chosen), result.batch_id, result.pushed)


def advance_run(db: Session, run: AutomationRun, now: datetime) -> None:
    task = db.get(AutomationTask, run.task_id)
    if task is None:
        _finish(run, "cancelled", "Task deleted", now)
        return
    waves = run.waves or []
    if waves and not waves[-1].get("settled_at"):
        if not _settle(db, run, task, now) or run.status != RUNNING:
            return
    if run.next_wave_at is not None and now >= run.next_wave_at:
        _start_wave(db, run, task, now)


def sweep(db: Session, now: Optional[datetime] = None) -> dict:
    """Start the tasks that came due, move every running run forward."""
    now = now or utcnow_naive()
    started = 0
    due = (
        db.query(AutomationTask)
        .filter(AutomationTask.enabled.is_(True), AutomationTask.next_run_at.isnot(None), AutomationTask.next_run_at <= now)
        .all()
    )
    for task in due:
        task.next_run_at = next_run_after(task, now)
        if active_run(db, task.id) is None:
            start_run(db, task, trigger="schedule", started_by=None, now=now)
            started += 1
        else:
            logger.info("[automation] task #%d: previous run still in progress; this start skipped", task.id)
        db.commit()
    advanced = 0
    for run in db.query(AutomationRun).filter(AutomationRun.status == RUNNING).all():
        advance_run(db, run, now)
        db.commit()
        advanced += 1
    return {"started": started, "running": advanced}
