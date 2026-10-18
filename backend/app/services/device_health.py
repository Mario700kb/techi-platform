"""Reading and keeping a device's health report (agent >= 2.1.33).

Each report carries the last 25 hours of critical System events; the platform
keeps the union of what it has received for 7 days (by event record id), so a
blue screen two days ago is still listed after the agent's window moved on.
A pending restart is dated from the first report that showed it: the agent
cannot tell how long Windows has been waiting.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import List, Optional

from app.schemas.device_health import (
    ALERTING_CATEGORIES,
    ALERTING_REBOOT_REASONS,
    MAX_EVENTS,
    DeviceHealth,
    HealthEvent,
    PhysicalDisk,
)

EVENT_KEEP = timedelta(days=7)


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def health_from_json(raw_json: Optional[str]) -> Optional[DeviceHealth]:
    """device_inventory.health_json → DeviceHealth (None when absent or unreadable)."""
    if not raw_json:
        return None
    try:
        return DeviceHealth.model_validate_json(raw_json)
    except ValueError:
        return None


def merge_health(previous: Optional[DeviceHealth], new: DeviceHealth, now: datetime) -> DeviceHealth:
    """The report to store: ``new`` with the events kept from ``previous`` and
    the date the restart was first seen pending."""
    now = _aware(now)
    events: dict[tuple, HealthEvent] = {}
    for event in (previous.events if previous else []) + new.events:
        if now - _aware(event.at) <= EVENT_KEEP:
            events[(event.source.lower(), event.record_id)] = event
    kept = sorted(events.values(), key=lambda e: _aware(e.at), reverse=True)[:MAX_EVENTS]

    since: Optional[datetime] = None
    if new.reboot_pending:
        since = previous.reboot_pending_since if previous and previous.reboot_pending else None
        since = since or now
    return new.model_copy(update={"events": kept, "reboot_pending_since": since})


def disks_with_problems(health: Optional[DeviceHealth]) -> List[PhysicalDisk]:
    return [d for d in (health.disks if health else []) if d.problem]


def alerting_events(health: Optional[DeviceHealth], now: datetime, window: timedelta = timedelta(hours=24)) -> List[HealthEvent]:
    """Crashes, hardware and disk errors in the window, newest first."""
    if health is None:
        return []
    now = _aware(now)
    return [e for e in health.events if e.category in ALERTING_CATEGORIES and now - _aware(e.at) <= window]


def reboot_pending_days(health: Optional[DeviceHealth], now: datetime) -> Optional[float]:
    """Days a restart has waited for a reason that matters; None when none is pending
    (or the report cannot tell)."""
    if health is None or not health.reboot_pending or health.reboot_pending_since is None:
        return None
    if health.reboot_reasons and not any(r in ALERTING_REBOOT_REASONS for r in health.reboot_reasons):
        return None
    return max(0.0, (_aware(now) - _aware(health.reboot_pending_since)).total_seconds() / 86400)
