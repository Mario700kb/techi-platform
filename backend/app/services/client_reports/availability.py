"""Availability & outages from device_status_history.

Each device's period is cut into online and offline stretches at its status
transitions; the status at the start is the last transition before it (or the
first transition's previous status, or the device's current status when it
never changed). Servers and other always-on devices count around the clock;
workstations only within working hours (settings.WORK_DAYS / WORK_START /
WORK_END in Tirana time, Mon–Fri 08:00–17:00), so a PC switched off at night is
not "down". An outage is an offline stretch of an always-on device lasting at
least OUTAGE_MIN.

The status is set by the heartbeat sweep, so a transition is recorded a few
minutes after the device actually stopped answering.
"""
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func

from app.core.time import ensure_utc, format_display
from app.models.device import Device, DeviceStatus
from app.models.device_status_history import DeviceStatusHistory
from app.schemas.client_report import ReportKpi, ReportSection
from app.services.client_reports.common import (
    CRIT, WARN, Built, Issue, Recommendation, ReportContext, col, device_cells, device_columns,
    human_duration, iso, is_always_on, pct, plural,
)
from app.services.offline_alerts import WorkHours

KEY = "availability"
OUTAGE_MIN = timedelta(minutes=10)
MAX_OUTAGES = 200
TARGET_PCT = 99.0

Span = Tuple[datetime, datetime]


def _online(status) -> bool:
    return getattr(status, "value", status) == DeviceStatus.ONLINE.value


def _naive(dt: datetime) -> datetime:
    return ensure_utc(dt).replace(tzinfo=None)


def _history(ctx: ReportContext) -> Tuple[Dict[int, DeviceStatusHistory], Dict[int, List[DeviceStatusHistory]]]:
    """The last transition before the period and the transitions within it, per device."""
    ids = [d.id for d in ctx.devices]
    if not ids:
        return {}, {}
    start, end = _naive(ctx.start), _naive(ctx.end)
    latest = (
        ctx.db.query(DeviceStatusHistory.device_id, func.max(DeviceStatusHistory.created_at).label("at"))
        .filter(DeviceStatusHistory.device_id.in_(ids), DeviceStatusHistory.created_at < start)
        .group_by(DeviceStatusHistory.device_id)
        .subquery()
    )
    before: Dict[int, DeviceStatusHistory] = {}
    for row in (
        ctx.db.query(DeviceStatusHistory)
        .join(latest, (DeviceStatusHistory.device_id == latest.c.device_id) & (DeviceStatusHistory.created_at == latest.c.at))
        .order_by(DeviceStatusHistory.id)
    ):
        before[row.device_id] = row
    within: Dict[int, List[DeviceStatusHistory]] = defaultdict(list)
    for row in (
        ctx.db.query(DeviceStatusHistory)
        .filter(DeviceStatusHistory.device_id.in_(ids), DeviceStatusHistory.created_at >= start,
                DeviceStatusHistory.created_at < end)
        .order_by(DeviceStatusHistory.device_id, DeviceStatusHistory.created_at, DeviceStatusHistory.id)
    ):
        within[row.device_id].append(row)
    return before, within


def timeline(device: Device, start: datetime, end: datetime, before: Optional[DeviceStatusHistory],
             changes: List[DeviceStatusHistory]) -> Tuple[List[Span], List[Tuple[datetime, datetime, Optional[str]]]]:
    """(online spans, offline spans with the reason they began) within [start, end)."""
    if before is not None:
        online, reason = _online(before.new_status), before.reason
    elif changes and changes[0].previous_status is not None:
        online, reason = _online(changes[0].previous_status), None
    elif changes:
        online, reason = not _online(changes[0].new_status), None
    else:
        online, reason = _online(device.status), device.offline_reason
    on: List[Span] = []
    off: List[Tuple[datetime, datetime, Optional[str]]] = []
    cursor = start
    for change in changes:
        at = max(start, min(end, ensure_utc(change.created_at)))
        now_online = _online(change.new_status)
        if now_online == online:
            continue
        if at > cursor:
            (on.append((cursor, at)) if online else off.append((cursor, at, reason)))
        cursor, online, reason = at, now_online, change.reason
    if end > cursor:
        (on.append((cursor, end)) if online else off.append((cursor, end, reason)))
    return on, off


def _overlap(spans: List[Span], windows: List[Span]) -> float:
    total = 0.0
    for a0, a1 in spans:
        for b0, b1 in windows:
            lo, hi = max(a0, b0), min(a1, b1)
            if hi > lo:
                total += (hi - lo).total_seconds()
    return total


def working_windows(start: datetime, end: datetime, hours: WorkHours) -> List[Span]:
    windows = []
    day = start.astimezone(hours.zone).date()
    last = end.astimezone(hours.zone).date()
    while day <= last:
        noon = datetime(day.year, day.month, day.day, 12, tzinfo=hours.zone)
        window = hours.window(noon)
        if window is not None:
            lo, hi = max(window[0], start), min(window[1], end)
            if hi > lo:
                windows.append((lo, hi))
        day += timedelta(days=1)
    return windows


def build(ctx: ReportContext) -> Built:
    before, within = _history(ctx)
    hours = WorkHours.from_settings()
    servers, workstations, outages = [], [], []
    server_total = server_online = 0.0
    live_end = ctx.end >= ctx.now - timedelta(minutes=10)
    for device in ctx.devices:
        registered = ensure_utc(device.registered_at) if device.registered_at else None
        start = max(ctx.start, registered) if registered else ctx.start
        if start >= ctx.end:
            continue
        on, off = timeline(device, start, ctx.end, before.get(device.id), within.get(device.id, []))
        if is_always_on(device):
            total = (ctx.end - start).total_seconds()
            online = sum((b - a).total_seconds() for a, b in on)
            mine = []
            for a, b, reason in off:
                if b - a < OUTAGE_MIN:
                    continue
                ongoing = b >= ctx.end
                state = ("Ongoing" if live_end else "Continues after period") if ongoing else "Resolved"
                mine.append({**device_cells(device), "start": iso(a), "end": None if ongoing else iso(b),
                             "duration": int((b - a).total_seconds()), "state": state,
                             "reason": (reason or "").replace("_", " ") or None,
                             "_tone": "crit" if ongoing else "warn"})
            outages.extend(mine)
            server_total += total
            server_online += online
            share = pct(online, total)
            longest = max((r["duration"] for r in mine), default=None)
            servers.append({**device_cells(device), "availability": share, "downtime": int(total - online),
                            "outages": len(mine), "longest": longest,
                            "_tone": "ok" if share is None or share >= TARGET_PCT else "warn" if share >= 95 else "crit"})
        else:
            windows = working_windows(start, ctx.end, hours)
            work = sum((b - a).total_seconds() for a, b in windows)
            if work <= 0:
                continue
            online = _overlap(on, windows)
            share = pct(online, work)
            workstations.append({**device_cells(device), "availability": share, "offline": int(work - online),
                                 "last_seen": iso(device.last_seen),
                                 "_tone": "ok" if share >= 90 else "warn" if share >= 60 else "neutral"})

    servers.sort(key=lambda r: (r["availability"] if r["availability"] is not None else 101, r["device"].lower()))
    workstations.sort(key=lambda r: (r["availability"], r["device"].lower()))
    outages.sort(key=lambda r: (-r["duration"], r["start"]))
    shown_outages = outages[:MAX_OUTAGES]

    fleet = pct(server_online, server_total)
    under = [r for r in servers if r["availability"] is not None and r["availability"] < TARGET_PCT]
    longest = outages[0] if outages else None
    summary = [
        ReportKpi(label="Server availability", value=fleet, kind="percent",
                  tone="neutral" if fleet is None else "ok" if fleet >= TARGET_PCT else "warn" if fleet >= 95 else "crit",
                  hint=f"{plural(len(servers), 'always-on device')}, 24/7" if servers else "No servers or always-on devices"),
        ReportKpi(label="Outages", value=len(outages), tone="warn" if outages else "ok",
                  hint=f"Server offline {int(OUTAGE_MIN.total_seconds() // 60)} min or longer"),
        ReportKpi(label="Longest outage", value=longest["duration"] if longest else None, kind="duration",
                  tone="crit" if longest and longest["duration"] >= 3600 else "warn" if longest else "ok",
                  hint=f"{longest['device']}, {format_display(datetime.fromisoformat(longest['start']), '%d %b %H:%M')}" if longest else "None in the period"),
        ReportKpi(label=f"Servers under {TARGET_PCT:g}%", value=len(under), tone="crit" if under else "ok",
                  hint=f"Of {len(servers)}"),
    ]
    if workstations:
        work_pct = round(sum(r["availability"] for r in workstations) / len(workstations), 1)
        summary.append(ReportKpi(label="Workstations online in working hours", value=work_pct, kind="percent",
                                 tone="neutral", hint=f"Average of {plural(len(workstations), 'workstation')}"))
    sections = [
        ReportSection(
            key="servers", title="Servers",
            description="Always-on devices (servers, network, storage, hypervisors), measured 24/7. Lowest first.",
            columns=[*device_columns(), col("availability", "Availability", "percent"), col("downtime", "Downtime", "duration"),
                     col("outages", "Outages", "number"), col("longest", "Longest", "duration")],
            rows=servers, empty="This client has no servers or other always-on devices.",
        ),
        ReportSection(
            key="outages", title="Outages",
            description=f"Each time an always-on device was offline for {int(OUTAGE_MIN.total_seconds() // 60)} minutes or more, longest first.",
            columns=[col("device", "Device"), col("start", "Start", "datetime"), col("end", "End", "datetime"),
                     col("duration", "Duration", "duration"), col("state", "State", "badge"), col("reason", "Reason")],
            rows=shown_outages, empty="No outages in the period.",
            note=f"Showing the {MAX_OUTAGES} longest of {len(outages)} outages." if len(outages) > MAX_OUTAGES else None,
        ),
        ReportSection(
            key="workstations", title="Workstations",
            description="Share of working hours (Mon–Fri 08:00–17:00, Tirana) the workstation was online. Lowest first; "
                        "holidays and leave count as offline.",
            columns=[*device_columns(), col("availability", "Online in working hours", "percent"),
                     col("offline", "Offline in working hours", "duration"), col("last_seen", "Last seen", "datetime")],
            rows=workstations, empty="No workstations with working hours in the period.",
        ),
    ]
    document = ctx.document(
        key=KEY, title="Availability & outages", subtitle=None, summary=summary, sections=sections,
        notes=["Online and offline are the platform's status of the device: the agent's heartbeat stopped, or came back. "
               "A transition is recorded a few minutes after the device stopped answering.",
               "Status history is kept from August 2026; earlier periods are incomplete."],
    )

    issues, recs = [], []
    for row in [r for r in outages if r["state"] == "Ongoing"][:3]:
        issues.append(Issue(CRIT, f"{row['device']} is offline since {format_display(datetime.fromisoformat(row['start']), '%d %b %H:%M')}", KEY))
    for row in under[:3]:
        issues.append(Issue(CRIT if row["availability"] < 95 else WARN,
                            f"{row['device']} available {row['availability']:g}% ({plural(row['outages'], 'outage')}, "
                            f"longest {human_duration(row['longest'])})", KEY))
        recs.append(Recommendation(75, f"Investigate the {plural(row['outages'], 'outage')} of {row['device']} "
                                       f"(available {row['availability']:g}%, longest {human_duration(row['longest'])})."))
    facts = {"server_pct": fleet, "servers": len(servers), "outages": len(outages),
             "longest": longest["duration"] if longest else None}
    return Built(document, issues, recs, facts)
