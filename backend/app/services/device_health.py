"""Reading and keeping a device's health report (agent >= 2.1.33).

Each report carries the last 25 hours of critical System events; the platform
keeps the union of what it has received for 7 days (by event record id), so a
blue screen two days ago is still listed after the agent's window moved on.
A pending restart is dated from the first report that showed it: the agent
cannot tell how long Windows has been waiting.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from app.schemas.device_health import (
    ALERTING_CATEGORIES,
    ALERTING_REBOOT_REASONS,
    MAX_EVENTS,
    DeviceHealth,
    HealthEvent,
    PhysicalDisk,
)

EVENT_KEEP = timedelta(days=7)

# NTFS 98 is written at every mount, at Information level: "Volume C: is
# healthy. No action is needed." Only the variant that asks for a repair
# matters, and its text names the commands, in every Windows language.
_REPAIR_WORDS = ("chkdsk", "repair-volume")
# Information (4), Verbose (5) and "LogAlways" (0) are never a problem.
_QUIET_LEVELS = (0, 4, 5)


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
    return [
        e for e in health.events
        if e.category in ALERTING_CATEGORIES and now - _aware(e.at) <= window and is_actionable(e)
    ]


def reboot_pending_days(health: Optional[DeviceHealth], now: datetime) -> Optional[float]:
    """Days a restart has waited for a reason that matters; None when none is pending
    (or the report cannot tell)."""
    if health is None or not health.reboot_pending or health.reboot_pending_since is None:
        return None
    if health.reboot_reasons and not any(r in ALERTING_REBOOT_REASONS for r in health.reboot_reasons):
        return None
    return max(0.0, (_aware(now) - _aware(health.reboot_pending_since)).total_seconds() / 86400)


def is_actionable(event: HealthEvent) -> bool:
    """Whether an event from the report can be a problem at all."""
    if event.win_level is not None and event.win_level in _QUIET_LEVELS:
        return False
    if event.event_id == 98 and event.source.lower() in ("ntfs", "microsoft-windows-ntfs"):
        text = (event.message or "").lower()
        return any(word in text for word in _REPAIR_WORDS)
    return True


@dataclass
class FiringGroup:
    """One group of System events that meets its rule: what the critical
    events monitor opens an alert for."""

    key: str
    title: str
    severity: str
    count: int
    window_h: int
    events: List[HealthEvent] = field(default_factory=list)

    @property
    def fingerprint(self) -> str:
        return f"evt:{self.key}"


def _incidents(group: str, events: List[HealthEvent]) -> List[List[HealthEvent]]:
    """Events of one group, oldest first, as incidents: a Kernel-Power 41 and
    the EventLog 6008 of the same boot are one shutdown."""
    from app.services.alert_rules import SAME_INCIDENT_SECONDS

    ordered = sorted(events, key=lambda e: _aware(e.at))
    if group != "shutdown":
        return [[e] for e in ordered]
    out: List[List[HealthEvent]] = []
    for event in ordered:
        if out and (_aware(event.at) - _aware(out[-1][-1].at)).total_seconds() <= SAME_INCIDENT_SECONDS:
            out[-1].append(event)
        else:
            out.append([event])
    return out


def firing_event_groups(
    health: Optional[DeviceHealth], now: datetime, *, is_server: bool, base_severity: str = "warning"
) -> List[FiringGroup]:
    """The event groups whose rule fires now (EVENT_GROUPS), most severe first."""
    from app.services.alert_rules import EVENT_GROUP_OF, EVENT_GROUPS

    if health is None:
        return []
    now = _aware(now)
    by_group: Dict[str, List[HealthEvent]] = {}
    for event in health.events:
        group = EVENT_GROUP_OF.get((event.source.lower(), event.event_id))
        if group is None or not is_actionable(event):
            continue
        by_group.setdefault(group, []).append(event)
    firing: List[FiringGroup] = []
    for key, events in by_group.items():
        rule = EVENT_GROUPS[key]
        window_h, min_count = rule.window_h, rule.min_count
        if not is_server and rule.pc_window_h:
            window_h, min_count = rule.pc_window_h, rule.pc_min_count or min_count
        recent = [e for e in events if now - _aware(e.at) <= timedelta(hours=window_h)]
        incidents = _incidents(key, recent)
        if len(incidents) < min_count:
            continue
        # The alert lasts a day after the last incident, whatever the window.
        last = max(_aware(e.at) for e in recent)
        if now - last > timedelta(hours=24):
            continue
        severity = rule.severity.value if rule.severity else base_severity
        if rule.critical_from is not None:
            in_week = _incidents(key, [e for e in events if now - _aware(e.at) <= timedelta(days=7)])
            if is_server or len(in_week) >= rule.critical_from:
                severity = "critical"
        firing.append(FiringGroup(
            key=key,
            title=rule.title,
            severity=severity,
            count=len(incidents),
            window_h=window_h,
            events=sorted(recent, key=lambda e: _aware(e.at), reverse=True),
        ))
    rank = {"critical": 0, "warning": 1, "info": 2}
    return sorted(firing, key=lambda g: (rank.get(g.severity, 3), g.key))
