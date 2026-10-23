"""When a device that is out of contact raises a "device offline" alert.

Going offline itself raises nothing: staff switch their PCs off at the end of
the day, and Windows usually cuts power before the agent can report it, so
almost every offline transition is a missed heartbeat. Measured before this
policy: ~11,000 offline alerts a day, 94% closed within 15 minutes, and 4
agent-reported shutdowns against 14,732 heartbeat timeouts in three days.

The reconciliation worker runs this sweep every pass instead:

* Always-on devices (servers, network, storage, hypervisors): CRITICAL once
  out of contact OFFLINE_ALERT_ALWAYS_ON_MINUTES, at any hour; WARNING when the
  agent reported a clean shutdown or sleep.
* Workstations (everything else): WARNING only when contact was lost inside
  today's working hours and has stayed lost OFFLINE_ALERT_WORKSTATION_MINUTES
  (120), checked while still inside working hours, so with 08:00–17:00 only a
  PC lost before 15:00 can alert. Lunch, meetings, leaving early, a PC not
  switched on in the morning raise nothing, and neither does a PC whose agent
  said it was going to sleep or being shut down (a laptop closed for the
  afternoon: 50 of 317 alerts in Oct 2026).
* Workstations out of contact OFFLINE_ALERT_ABSENT_DAYS: one WARNING (broken,
  lost or retired; archive it if it is retired).

One alert per stage of an offline episode: the server/working-hours alert is
skipped when any offline alert was opened since the last contact, so one an
operator closed by hand is not reopened while the device stays away; the
long-absence alert only when one was opened after the absence began counting
as long. An open alert always blocks a new one. Alerts close when the device
comes back (DeviceStatusService.mark_online_from_heartbeat).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import and_, exists, func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.time import ensure_utc, utcnow
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.device import Device, DeviceStatus
from app.models.device_group import DeviceGroup
from app.platform_core import classification as clf

logger = logging.getLogger(__name__)

ALWAYS_ON_CATEGORIES = (
    clf.CATEGORY_SERVERS,
    clf.CATEGORY_NETWORK,
    clf.CATEGORY_STORAGE,
    clf.CATEGORY_HYPERVISORS,
)
_CLEAN_POWER_STATES = {"shutdown": "was shut down", "sleep": "went to sleep", "hibernate": "went to sleep"}


@dataclass(frozen=True)
class WorkHours:
    days: frozenset[int]
    start: time
    end: time
    zone: ZoneInfo

    @classmethod
    def from_settings(cls) -> "WorkHours":
        def clock(text: str) -> time:
            hours, minutes = text.split(":")
            return time(int(hours), int(minutes))

        return cls(
            days=frozenset(settings.WORK_DAYS),
            start=clock(settings.WORK_START),
            end=clock(settings.WORK_END),
            zone=ZoneInfo(settings.DISPLAY_TIMEZONE),
        )

    def window(self, now: datetime) -> Optional[tuple[datetime, datetime]]:
        """Today's working hours as aware UTC datetimes, or None on a day off."""
        local = ensure_utc(now).astimezone(self.zone)
        if local.isoweekday() not in self.days:
            return None
        start = datetime.combine(local.date(), self.start, tzinfo=self.zone)
        end = datetime.combine(local.date(), self.end, tzinfo=self.zone)
        return start.astimezone(ZoneInfo("UTC")), end.astimezone(ZoneInfo("UTC"))


def _naive(dt: datetime) -> datetime:
    """Aware UTC → the naive UTC form the columns store."""
    return ensure_utc(dt).replace(tzinfo=None)


def _hostname(device: Device) -> str:
    return device.hostname or device.rustdesk_id or f"device-{device.id}"


class OfflineAlertSweep:
    def __init__(self, db: Session, work_hours: Optional[WorkHours] = None):
        self.db = db
        self.work_hours = work_hours or WorkHours.from_settings()

    def _offline_devices(self):
        category = clf.category_case()
        query = (
            self.db.query(Device, category)
            .outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)
            .filter(
                Device.status == DeviceStatus.OFFLINE,
                Device.is_archived.is_(False),
                Device.last_seen.isnot(None),
            )
        )
        return query, category.in_(ALWAYS_ON_CATEGORIES)

    def _out_too_long(self, now: datetime):
        """Always-on devices past their grace period, and workstations lost
        inside today's working hours and past theirs."""
        query, always_on = self._offline_devices()
        due = [and_(always_on, Device.last_seen <= _naive(now - timedelta(minutes=settings.OFFLINE_ALERT_ALWAYS_ON_MINUTES)))]
        window = self.work_hours.window(now)
        if window and window[0] <= now < window[1]:
            due.append(
                and_(
                    ~always_on,
                    or_(Device.offline_reason.is_(None), Device.offline_reason.notin_(tuple(_CLEAN_POWER_STATES))),
                    Device.last_seen >= _naive(window[0]),
                    Device.last_seen <= _naive(now - timedelta(minutes=settings.OFFLINE_ALERT_WORKSTATION_MINUTES)),
                )
            )
        return query.filter(or_(*due))

    def _long_absent(self, now: datetime):
        """Workstations out of contact for OFFLINE_ALERT_ABSENT_DAYS or more."""
        if settings.OFFLINE_ALERT_ABSENT_DAYS <= 0:
            return None
        query, always_on = self._offline_devices()
        absent_after = timedelta(days=settings.OFFLINE_ALERT_ABSENT_DAYS)
        return query.filter(~always_on, Device.last_seen <= _naive(now - absent_after))

    def run(self, now: Optional[datetime] = None) -> int:
        """Opens the offline alerts now due. Returns how many were opened."""
        now = ensure_utc(now or utcnow())
        open_alert = DeviceAlert.state == AlertState.OPEN
        offline_alert = and_(DeviceAlert.device_id == Device.id, DeviceAlert.kind == AlertKind.DEVICE_OFFLINE)

        # Two NOT EXISTS rather than one with an OR. An alert that came back
        # reopens its old row, so "opened this episode" is its last opening.
        last_opened = func.coalesce(DeviceAlert.last_seen_at, DeviceAlert.created_at)
        due = (
            self._out_too_long(now)
            .filter(~exists().where(offline_alert, open_alert))
            .filter(~exists().where(offline_alert, last_opened >= Device.last_seen))
            .all()
        )

        absent = self._long_absent(now)
        if absent is not None:
            # "Opened after the absence began counting as long" needs
            # last_seen + N days, which is dialect-specific in SQL; the few
            # long-absent devices are checked here instead.
            absent_after = timedelta(days=settings.OFFLINE_ALERT_ABSENT_DAYS)
            for device, category in absent.filter(~exists().where(offline_alert, open_alert)).all():
                latest = (
                    self.db.query(func.max(last_opened))
                    .filter(DeviceAlert.device_id == device.id, DeviceAlert.kind == AlertKind.DEVICE_OFFLINE)
                    .scalar()
                )
                if latest is None or ensure_utc(latest) < ensure_utc(device.last_seen) + absent_after:
                    due.append((device, category))

        return self._open(due, now)

    def _open(self, rows, now: datetime) -> int:
        from app.services.alert_engine import AlertEngine

        engine = AlertEngine(self.db)
        opened = 0
        for device, category in rows:
            severity, message, detail = self._describe(device, category, now)
            if engine.open_offline_alert(device, severity=severity, message=message, detail=detail):
                opened += 1
        if opened:
            logger.info("Opened %s offline alerts", opened)
        return opened

    def apply_to_open_alerts(self, now: Optional[datetime] = None) -> tuple[int, int]:
        """One-off when the policy changes: open offline alerts the policy
        would not raise now are closed; the rest are reworded (and re-rated)
        to what it would raise. Returns (rewritten, closed)."""
        from app.services.alert_engine import AlertEngine

        now = ensure_utc(now or utcnow())
        due = {device.id: (device, category) for device, category in self._out_too_long(now).all()}
        absent = self._long_absent(now)
        if absent is not None:
            due.update({device.id: (device, category) for device, category in absent.all()})
        open_alerts = (
            self.db.query(DeviceAlert)
            .filter(DeviceAlert.kind == AlertKind.DEVICE_OFFLINE, DeviceAlert.state == AlertState.OPEN)
            .all()
        )
        engine = AlertEngine(self.db)
        rewritten = closed = 0
        for alert in open_alerts:
            if alert.device_id in due:
                device, category = due[alert.device_id]
                alert.severity, alert.message, alert.detail = self._describe(device, category, now)
                rewritten += 1
            elif engine._resolve(alert.device_id, AlertKind.DEVICE_OFFLINE, reason="offline_policy"):
                closed += 1
        self.db.commit()
        return rewritten, closed

    def _describe(self, device: Device, category: str, now: datetime) -> tuple[AlertSeverity, str, str]:
        name = _hostname(device)
        last_seen = ensure_utc(device.last_seen)
        zone = self.work_hours.zone
        since = f"No contact since {last_seen.astimezone(zone).strftime('%d %b %H:%M')}."
        absent_after = timedelta(days=settings.OFFLINE_ALERT_ABSENT_DAYS)
        if settings.OFFLINE_ALERT_ABSENT_DAYS > 0 and now - last_seen >= absent_after and category not in ALWAYS_ON_CATEGORIES:
            return (
                AlertSeverity.WARNING,
                f"{name} not seen for {settings.OFFLINE_ALERT_ABSENT_DAYS} days",
                f"{since} It may be broken, lost or retired; archive it if it is no longer in use.",
            )
        if category in ALWAYS_ON_CATEGORIES:
            verb = _CLEAN_POWER_STATES.get(device.offline_reason or "")
            if verb:
                return (
                    AlertSeverity.WARNING,
                    f"{name} {verb}",
                    f"The agent reported a clean {device.offline_reason} and it has not come back. {since}",
                )
            return AlertSeverity.CRITICAL, f"{name} went offline", since
        return (
            AlertSeverity.WARNING,
            f"{name} offline during working hours",
            f"{since} Contact was lost during working hours ({settings.WORK_START}–{settings.WORK_END}).",
        )


if __name__ == "__main__":
    # python -m app.services.offline_alerts --apply-to-open-alerts
    import sys

    from app.db.session import SessionLocal

    if sys.argv[1:] != ["--apply-to-open-alerts"]:
        sys.exit("usage: python -m app.services.offline_alerts --apply-to-open-alerts")
    session = SessionLocal()
    try:
        rewritten, closed = OfflineAlertSweep(session).apply_to_open_alerts()
        print(f"open offline alerts: {rewritten} rewritten to the new policy, {closed} closed")
    finally:
        session.close()
