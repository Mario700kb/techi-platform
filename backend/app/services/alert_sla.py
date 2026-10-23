"""Alert deadlines and escalation: when an alert must be taken and fixed,
who is told when it is not, and who keeps the queue (the dispatcher).

The deadlines are stamped once, when an alert opens or reopens, so no read
computes the working-hours calendar. Every escalation step is due at a known
time: the alert keeps it in next_check_at, and the sweep (every minute) reads
only the open rows whose time has come, through a partial index. Nothing here
runs on the heartbeat path beyond setting a few columns on an opening.

The clock counts working hours (WORK_DAYS, WORK_START–WORK_END in
DISPLAY_TIMEZONE), except for a P1 on a server, which counts every hour.
Waiting on the client, a vendor or a part stops it; the time spent waiting
is added back to every deadline.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow_naive
from app.models.alert import AlertActivity, AlertDutyShift, AlertState, DeviceAlert
from app.models.operator import Operator

logger = logging.getLogger(__name__)

UTC = ZoneInfo("UTC")


# ── the clock ───────────────────────────────────────────────────────────────

class WorkClock:
    """Minutes of working time, from and between naive UTC datetimes."""

    # A clock that finds no working day this far ahead counts wall time.
    HORIZON_DAYS = 400

    def __init__(self, hours=None):
        from app.services.offline_alerts import WorkHours

        self.hours = hours or WorkHours.from_settings()

    @property
    def day_minutes(self) -> int:
        start = self.hours.start.hour * 60 + self.hours.start.minute
        end = self.hours.end.hour * 60 + self.hours.end.minute
        return max(60, end - start)

    def _windows(self, start: datetime):
        """Working windows (naive UTC) from the local day of ``start`` on."""
        local_day = ensure_utc(start).astimezone(self.hours.zone).date()
        for i in range(self.HORIZON_DAYS):
            day = local_day + timedelta(days=i)
            window = self.hours.window(datetime.combine(day, time(12), tzinfo=self.hours.zone))
            if window is not None:
                yield window[0].replace(tzinfo=None), window[1].replace(tzinfo=None)

    def add(self, start: datetime, minutes: float, round_the_clock: bool = False) -> datetime:
        if round_the_clock or minutes <= 0:
            return start + timedelta(minutes=max(0.0, minutes))
        left = float(minutes)
        for opens, closes in self._windows(start):
            begin = max(opens, start)
            if begin >= closes:
                continue
            room = (closes - begin).total_seconds() / 60
            if left <= room:
                return begin + timedelta(minutes=left)
            left -= room
        return start + timedelta(minutes=minutes)

    def between(self, a: datetime, b: datetime, round_the_clock: bool = False) -> float:
        if b <= a:
            return 0.0
        if round_the_clock:
            return (b - a).total_seconds() / 60
        total = 0.0
        for opens, closes in self._windows(a):
            if opens >= b:
                break
            begin, end = max(opens, a), min(closes, b)
            if end > begin:
                total += (end - begin).total_seconds() / 60
        return total


# ── deadlines by priority ───────────────────────────────────────────────────

@dataclass(frozen=True)
class Sla:
    ack_minutes: Optional[int]  # None: no deadline to take it
    resolve_minutes: int
    # Escalation steps this priority takes; 2 and 4 on a P3/P4 only mark the
    # alert (daily handover, weekly review), they notify nobody.
    steps: Tuple[int, ...]
    notifies: bool


def sla_for(priority: Optional[int], clock: Optional[WorkClock] = None) -> Sla:
    day = (clock or WorkClock()).day_minutes
    p = priority or 3
    if p == 1:
        return Sla(15, 4 * 60, (1, 2, 3, 4), True)
    if p == 2:
        return Sla(60, 8 * 60, (1, 2, 3, 4), True)
    if p == 3:
        return Sla(day, 3 * day, (2, 4), False)
    return Sla(None, 10 * day, (4,), False)


STEP_TITLES = {
    1: "Nobody took it: handed to the dispatcher",
    2: "Not taken in time",
    3: "No progress at half time",
    4: "Deadline missed",
}


def _step_offset(sla: Sla, step: int) -> Optional[float]:
    if step == 1:
        return sla.ack_minutes / 2 if sla.ack_minutes else None
    if step == 2:
        return float(sla.ack_minutes) if sla.ack_minutes else None
    if step == 3:
        return sla.resolve_minutes / 2
    return float(sla.resolve_minutes)


def deadline_fields(priority: Optional[int], is_server: bool, now: Optional[datetime] = None,
                    clock: Optional[WorkClock] = None) -> Dict[str, Any]:
    """The columns a new (or reopened) alert starts its clock with."""
    clock = clock or WorkClock()
    now = now or utcnow_naive()
    fields: Dict[str, Any] = {
        "sla_started_at": now, "sla_24x7": bool(priority == 1 and is_server), "sla_paused_minutes": 0,
        "sla_step": 0, "first_action_at": None, "waiting_reason": None, "waiting_since": None,
    }
    probe = _Probe(priority=priority, **fields)
    _fill_due(probe, clock)
    step = next_step(probe, clock)
    fields.update(ack_due_at=probe.ack_due_at, resolve_due_at=probe.resolve_due_at,
                  next_check_at=step[1] if step else None)
    return fields


@dataclass
class _Probe:
    priority: Optional[int]
    sla_started_at: datetime
    sla_24x7: bool
    sla_paused_minutes: int
    sla_step: int
    first_action_at: Optional[datetime]
    waiting_reason: Optional[str]
    waiting_since: Optional[datetime]
    ack_due_at: Optional[datetime] = None
    resolve_due_at: Optional[datetime] = None


def _fill_due(alert, clock: WorkClock) -> None:
    sla = sla_for(alert.priority, clock)
    start, paused, always = alert.sla_started_at, alert.sla_paused_minutes or 0, bool(alert.sla_24x7)
    alert.ack_due_at = clock.add(start, sla.ack_minutes + paused, always) if sla.ack_minutes else None
    alert.resolve_due_at = clock.add(start, sla.resolve_minutes + paused, always)


def next_step(alert, clock: Optional[WorkClock] = None) -> Optional[Tuple[int, datetime]]:
    """The next escalation step this alert has not taken, and when it is due."""
    if alert.sla_started_at is None:
        return None
    clock = clock or WorkClock()
    sla = sla_for(alert.priority, clock)
    for step in sla.steps:
        if step <= (alert.sla_step or 0):
            continue
        offset = _step_offset(sla, step)
        if offset is None:
            continue
        at = clock.add(alert.sla_started_at, offset + (alert.sla_paused_minutes or 0), bool(alert.sla_24x7))
        return step, at
    return None


def restamp(alert: DeviceAlert, is_server: bool, now: Optional[datetime] = None, clock: Optional[WorkClock] = None) -> None:
    for key, value in deadline_fields(alert.priority, is_server, now, clock).items():
        setattr(alert, key, value)


def schedule(alert: DeviceAlert, clock: Optional[WorkClock] = None) -> None:
    """Recompute the deadlines and the next check after the clock moved."""
    clock = clock or WorkClock()
    if alert.sla_started_at is None:
        return
    _fill_due(alert, clock)
    if alert.parent_id is not None or alert.waiting_since is not None:
        alert.next_check_at = None
        return
    step = next_step(alert, clock)
    alert.next_check_at = step[1] if step else None


def pause(alert: DeviceAlert, reason: str, now: Optional[datetime] = None) -> None:
    alert.waiting_reason = reason
    alert.waiting_since = alert.waiting_since or now or utcnow_naive()
    alert.next_check_at = None


def resume(alert: DeviceAlert, now: Optional[datetime] = None, clock: Optional[WorkClock] = None) -> float:
    """Ends a wait; the working minutes it lasted are added to the deadlines."""
    clock = clock or WorkClock()
    now = now or utcnow_naive()
    waited = 0.0
    if alert.waiting_since is not None:
        waited = clock.between(alert.waiting_since, now, bool(alert.sla_24x7))
        alert.sla_paused_minutes = int(round((alert.sla_paused_minutes or 0) + waited))
    alert.waiting_reason = None
    alert.waiting_since = None
    schedule(alert, clock)
    return waited


def sla_state(alert, now: Optional[datetime] = None) -> Optional[str]:
    """"ack_overdue" | "overdue" | "waiting" | None, for lists and counts."""
    now = now or utcnow_naive()
    if getattr(alert.state, "value", alert.state) != AlertState.OPEN.value or alert.sla_started_at is None:
        return None
    if alert.waiting_since is not None:
        return "waiting"
    if alert.resolve_due_at is not None and alert.resolve_due_at <= now:
        return "overdue"
    if alert.acknowledged_at is None and alert.ack_due_at is not None and alert.ack_due_at <= now:
        return "ack_overdue"
    return None


def overdue_filter(now: datetime):
    """SQL for open alerts past a deadline (the clock not stopped)."""
    return and_(
        DeviceAlert.waiting_since.is_(None),
        or_(
            DeviceAlert.resolve_due_at <= now,
            and_(DeviceAlert.acknowledged_at.is_(None), DeviceAlert.ack_due_at <= now),
        ),
    )


# ── the dispatcher ──────────────────────────────────────────────────────────

def _local_day(now: datetime, clock: WorkClock) -> date:
    return ensure_utc(now).astimezone(clock.hours.zone).date()


def duty_shift(db: Session, now: Optional[datetime] = None, clock: Optional[WorkClock] = None) -> Optional[AlertDutyShift]:
    """Today's shift (the last one entered wins where shifts overlap)."""
    clock = clock or WorkClock()
    today = _local_day(now or utcnow_naive(), clock)
    return (
        db.query(AlertDutyShift)
        .filter(AlertDutyShift.starts_on <= today, AlertDutyShift.ends_on >= today)
        .order_by(AlertDutyShift.id.desc())
        .first()
    )


def duty_operator(db: Session, now: Optional[datetime] = None) -> Optional[Operator]:
    shift = duty_shift(db, now)
    if shift is None:
        return None
    for person in (shift.operator, shift.backup):
        if person is not None and person.is_active:
            return person
    return None


def _name(operator: Optional[Operator]) -> Optional[str]:
    return (operator.display_name or operator.username) if operator is not None else None


# ── work on an alert ────────────────────────────────────────────────────────

def progress_since(db: Session, alert: DeviceAlert) -> Optional[datetime]:
    """When someone first worked on the alert's device since its clock
    started: a note, a PowerShell session, a script, a Remote Support session."""
    if alert.first_action_at is not None:
        return alert.first_action_at
    since = alert.sla_started_at or alert.created_at
    from app.models.remote_action import RemoteAction
    from app.models.remote_support_connection import RemoteSupportConnection
    from app.models.terminal_session import TerminalSession

    times = [
        db.query(func.min(TerminalSession.created_at))
        .filter(TerminalSession.device_id == alert.device_id, TerminalSession.created_at >= since).scalar(),
        db.query(func.min(RemoteAction.created_at))
        .filter(RemoteAction.device_id == alert.device_id, RemoteAction.created_at >= since).scalar(),
        db.query(func.min(RemoteSupportConnection.opened_at))
        .filter(RemoteSupportConnection.device_id == alert.device_id, RemoteSupportConnection.opened_at >= since).scalar(),
    ]
    found = [ensure_utc(t).replace(tzinfo=None) if t is not None and t.tzinfo else t for t in times if t is not None]
    return min(found) if found else None


# ── the sweep ───────────────────────────────────────────────────────────────

class AlertSlaService:
    # One sweep handles at most this many due alerts; the rest wait a minute.
    BATCH = 200

    def __init__(self, db: Session, clock: Optional[WorkClock] = None):
        self.db = db
        self.clock = clock or WorkClock()

    def stamp_missing(self, now: datetime) -> int:
        """Alerts opened before deadlines existed (the deploy): the clock
        starts now, so nothing is overdue the minute it ships."""
        from app.models.device import Device
        from app.services.alert_engine import device_is_server

        rows = (
            self.db.query(DeviceAlert, Device)
            .join(Device, Device.id == DeviceAlert.device_id)
            .filter(DeviceAlert.state == AlertState.OPEN.value, DeviceAlert.sla_started_at.is_(None))
            .limit(500)
            .all()
        )
        for alert, device in rows:
            restamp(alert, device_is_server(device), now, self.clock)
            if alert.parent_id is not None:
                alert.next_check_at = None
        if rows:
            self.db.commit()
        return len(rows)

    def sweep(self, now: Optional[datetime] = None) -> Dict[str, int]:
        now = now or utcnow_naive()
        stamped = self.stamp_missing(now)
        due = (
            self.db.query(DeviceAlert)
            .filter(DeviceAlert.state == AlertState.OPEN.value, DeviceAlert.next_check_at.isnot(None),
                    DeviceAlert.next_check_at <= now)
            .order_by(DeviceAlert.next_check_at)
            .limit(self.BATCH)
            .all()
        )
        fired = 0
        for alert in due:
            try:
                fired += self._advance(alert, now)
                self.db.commit()
            except Exception:
                logger.exception("Escalation failed for alert %s", alert.id)
                self.db.rollback()
        handover = self.send_handover_if_due(now)
        return {"stamped": stamped, "checked": len(due), "fired": fired, "handover": handover}

    def _advance(self, alert: DeviceAlert, now: datetime) -> int:
        if alert.parent_id is not None or alert.waiting_since is not None:
            alert.next_check_at = None
            return 0
        if alert.snoozed_until is not None and alert.snoozed_until > now:
            # Snoozed: the clock runs on, the reminders wait for it to end.
            alert.next_check_at = alert.snoozed_until
            return 0
        fired = 0
        step = next_step(alert, self.clock)
        while step is not None and step[1] <= now:
            fired += self._fire(alert, step[0], now)
            alert.sla_step = step[0]
            step = next_step(alert, self.clock)
        alert.next_check_at = step[1] if step else None
        return fired

    def _fire(self, alert: DeviceAlert, step: int, now: datetime) -> int:
        from app.repositories.alert_repository import AlertRepository

        repo = AlertRepository(self.db)
        sla = sla_for(alert.priority, self.clock)
        duty = duty_operator(self.db, now)
        owner = alert.assigned_to
        if step == 1:
            if alert.assigned_to_id is not None:
                return 0
            if duty is not None:
                alert.assigned_to_id = duty.id
                alert.updated_at = now
                repo.add_activity(alert.id, "auto_assigned", None,
                                  f"To the dispatcher {_name(duty)}: nobody took it in {sla.ack_minutes // 2} min")
                owner = duty
            else:
                repo.add_activity(alert.id, "sla_unowned", None, "Nobody took it and nobody is on duty")
            return self._notify(alert, step, sla, to=[_name(duty)] if duty else [], now=now)
        if step == 2:
            if alert.acknowledged_at is not None:
                return 0
            repo.add_activity(alert.id, "sla_take_missed", None, f"Not taken within {_minutes(sla.ack_minutes)}")
            shift = duty_shift(self.db, now, self.clock)
            to = [n for n in (_name(owner), _name(duty), _name(shift.backup) if shift else None) if n]
            return self._notify(alert, step, sla, to=sorted(set(to)), now=now)
        if step == 3:
            started = progress_since(self.db, alert)
            if started is not None:
                alert.first_action_at = alert.first_action_at or started
                return 0
            repo.add_activity(alert.id, "sla_no_progress", None,
                              f"Half of the {_minutes(sla.resolve_minutes)} gone with no note, session or script")
            return self._notify(alert, step, sla, to=[n for n in (_name(owner), _name(duty)) if n], now=now)
        repo.add_activity(alert.id, "sla_breached", None, f"Not fixed within {_minutes(sla.resolve_minutes)}")
        return self._notify(alert, step, sla, to=[n for n in (_name(owner), "the manager") if n], now=now)

    def _notify(self, alert: DeviceAlert, step: int, sla: Sla, *, to: List[str], now: datetime) -> int:
        from app.services.alert_engine import _alert_payload
        from app.services.notification_events import NotificationEvent
        from app.services.notification_service import NotificationService
        from app.websocket.events import RealtimeEventType, build_event
        from app.websocket.publisher import realtime_publisher

        alert.updated_at = now
        realtime_publisher.publish_threadsafe(
            build_event(RealtimeEventType.ALERT_CREATED, data=_alert_payload(alert), reason="escalated"),
            dedupe_key=f"alert_escalated:{alert.id}:{step}",
        )
        if not sla.notifies:
            return 0
        device = alert.device
        name = ((device.display_name or "").strip() or device.hostname) if device is not None else f"Device #{alert.device_id}"
        who = f" For: {', '.join(to)}." if to else ""
        NotificationService(self.db).dispatch(
            event_type=NotificationEvent.ALERT_ESCALATED,
            title=f"P{alert.priority} · {STEP_TITLES[step]}: {alert.message}"[:255],
            message=f"{name}. {STEP_TITLES[step]}.{who}",
            severity=getattr(alert.severity, "value", alert.severity),
            device_id=alert.device_id,
            client_id=getattr(device, "client_id", None),
            payload={"alert_id": alert.id, "priority": alert.priority, "step": step, "to": to},
        )
        return 1

    # ── the end-of-day handover ─────────────────────────────────────────────

    HANDOVER_BEFORE_END = timedelta(minutes=15)
    _handover_sent_on: Optional[date] = None

    def send_handover_if_due(self, now: datetime) -> int:
        """Fifteen minutes before the working day ends, once a day: what is
        open, whose it is, when it is due and the last note."""
        window = self.clock.hours.window(ensure_utc(now))
        if window is None:
            return 0
        closes = window[1].replace(tzinfo=None)
        if not (closes - self.HANDOVER_BEFORE_END <= now < closes):
            return 0
        today = _local_day(now, self.clock)
        if AlertSlaService._handover_sent_on == today:
            return 0
        AlertSlaService._handover_sent_on = today
        from app.models.notification import NotificationDelivery
        from app.services.notification_events import NotificationEvent
        from app.services.notification_service import NotificationService

        # Sent before a restart today: not again.
        if self.db.query(NotificationDelivery.id).filter(
            NotificationDelivery.event_type == NotificationEvent.ALERT_HANDOVER,
            NotificationDelivery.created_at >= window[0].replace(tzinfo=None),
        ).first() is not None:
            return 0
        rows = handover(self.db, None, now)
        if not rows:
            return 0
        lines = []
        for row in rows:
            due = row["resolve_due_at"].strftime("%d %b %H:%M UTC") if row["resolve_due_at"] else "—"
            state = {"overdue": " · OVERDUE", "ack_overdue": " · not taken", "waiting": " · waiting"}.get(row["sla_state"] or "", "")
            note = f" — {row['last_note']}" if row["last_note"] else ""
            lines.append(f"P{row['priority']} {row['title']} · {row['device_name']} · {row['owner'] or 'no owner'} · due {due}{state}{note}")
        shift = duty_shift(self.db, now, self.clock)
        NotificationService(self.db).dispatch(
            event_type=NotificationEvent.ALERT_HANDOVER,
            title=f"Alert handover {today:%d %b}: {len(rows)} open",
            message="\n".join(lines[:100]),
            severity="info",
            payload={"count": len(rows), "dispatcher": _name(shift.operator) if shift else None},
        )
        return 1


def _minutes(minutes: Optional[int]) -> str:
    if not minutes:
        return "—"
    return f"{minutes} min" if minutes < 60 else f"{minutes / 60:g} h"


# ── the handover list ───────────────────────────────────────────────────────

def handover(db: Session, scope, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Open alerts someone owns, plus every P1–P2: what the next shift takes
    over. Incident followers are left out (their lead stands for them)."""
    from app.repositories.alert_repository import AlertQueueRepository
    from app.services.alert_center_service import alert_out

    now = now or utcnow_naive()
    repo = AlertQueueRepository(db)
    query = repo._base(scope).filter(
        DeviceAlert.state == AlertState.OPEN.value,
        DeviceAlert.parent_id.is_(None),
        or_(DeviceAlert.assigned_to_id.isnot(None), func.coalesce(DeviceAlert.priority, 3) <= 2),
    )
    rows = query.order_by(func.coalesce(DeviceAlert.priority, 3), DeviceAlert.resolve_due_at.asc()).limit(300).all()
    ids = [row[0].id for row in rows]
    notes: Dict[int, str] = {}
    if ids:
        latest = (
            db.query(func.max(AlertActivity.id).label("last_id"))
            .filter(AlertActivity.alert_id.in_(ids), AlertActivity.action.in_(("note", "waiting")))
            .group_by(AlertActivity.alert_id)
            .subquery()
        )
        for alert_id, detail in db.query(AlertActivity.alert_id, AlertActivity.detail).join(
            latest, AlertActivity.id == latest.c.last_id
        ):
            notes[alert_id] = (detail or "")[:200]
    out = []
    for row in rows:
        alert = row[0]
        item = alert_out(*row)
        out.append({
            "id": alert.id, "priority": alert.priority or 3, "title": item.title or alert.message,
            "device_name": item.device_name or f"Device #{alert.device_id}", "client_name": item.client_name,
            "owner": item.assigned_to_name, "resolve_due_at": alert.resolve_due_at, "ack_due_at": alert.ack_due_at,
            "sla_state": sla_state(alert, now), "waiting_reason": alert.waiting_reason,
            "last_note": notes.get(alert.id),
        })
    return out


__all__ = [
    "AlertSlaService", "WorkClock", "deadline_fields", "duty_operator", "duty_shift", "handover", "next_step",
    "overdue_filter", "pause", "progress_since", "restamp", "resume", "schedule", "sla_for", "sla_state",
]
