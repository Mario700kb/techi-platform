"""Device report snapshots for the existing ReportService.

Only existing persisted sources are read. This module does not write events or
affect the device timeline.
"""

import csv
import io
import json
from datetime import datetime, timedelta
from sqlalchemy import or_, func

from app.core.time import ensure_utc, utcnow
from app.models.alert import DeviceAlert
from app.models.device_activity_event import DeviceActivityEvent
from app.models.device_inventory import DeviceInventory
from app.models.device_note import DeviceNote
from app.models.device_status_history import DeviceStatusHistory
from app.models.device import DeviceStatus
from app.models.device_telemetry import DeviceTelemetry
from app.models.remote_action import RemoteAction
from app.services.device_health_score_service import DeviceHealthScoreService
from app.services.report_output import safe_text, csv_cell


SECTION_ORDER = (
    "overview", "user_activity", "status_uptime", "health", "alerts", "actions",
    "software", "remote_support", "assignments", "notes", "event_history",
)
SECTION_TITLES = {
    "overview": "Device Overview", "user_activity": "User Activity",
    "status_uptime": "Status / Uptime", "health": "Health", "alerts": "Alerts",
    "actions": "Actions", "software": "Software", "remote_support": "Remote Support",
    "assignments": "Assignment History", "notes": "Notes", "event_history": "Event History",
}
RETENTION_DAYS = {
    "user_activity": 7, "status_uptime": 60, "health": 7, "alerts": 90,
    "actions": 90, "remote_support": 7, "assignments": 7,
    "event_history": 7,
}
_ROW_LIMIT = 500


def _text(value) -> str:
    if value is None:
        return ""
    return str(getattr(value, "value", value))


def _safe(value) -> str:
    return safe_text(value)


def _time(value) -> str:
    return value.strftime("%Y-%m-%d %H:%M UTC") if value else ""


def _csv_cell(value) -> str:
    return csv_cell(value)


def _rows(query, ordered_column):
    rows = query.order_by(ordered_column.asc()).limit(_ROW_LIMIT + 1).all()
    return rows[:_ROW_LIMIT], len(rows) > _ROW_LIMIT


def _section(headers, rows, note="", truncated=False):
    if truncated:
        note = (note + " " if note else "") + f"Showing first {_ROW_LIMIT} rows; additional records were omitted."
    return {"headers": headers, "rows": rows, "note": note}


def _retention_note(section: str, start: datetime, now: datetime) -> str:
    days = RETENTION_DAYS.get(section)
    if days and ensure_utc(start) < now - timedelta(days=days):
        return f"Source retention is {days} days; records before {_time(now - timedelta(days=days))} may no longer exist."
    return ""


def build_device_snapshot(db, device, client_name: str, group_name: str, report_type: str, start: datetime, end: datetime, generated_by: str) -> dict:
    now = utcnow()
    wanted = SECTION_ORDER if report_type == "full" else (report_type,)
    sections = {}
    health_score, health_state, health_reasons = DeviceHealthScoreService(db).compute_for_device(device)
    identity = [
        ("Device name", device.display_name or device.hostname), ("Device ID", device.id),
        ("Client", client_name), ("Group", group_name), ("Platform", device.platform),
        ("OS", device.os_caption or device.os_name), ("OS version", device.os_version),
        ("Domain", device.domain), ("Current user", device.current_user),
        ("Local IP", device.local_ip), ("Public IP", device.public_ip),
        ("Agent version", device.agent_version), ("Status", device.status),
        ("Health", f"{health_state} ({health_score})"), ("Last seen", _time(device.last_seen)),
        ("Remote Support status", device.rustdesk_status),
    ]
    if "overview" in wanted:
        sections["overview"] = _section(["Field", "Current value"], [[name, _safe(value)] for name, value in identity], "Current snapshot; these values are not historical for the selected period.")

    event_types = {
        "user_activity": ("user_changed",),
        "health": ("health_warning", "health_critical", "health_recovered"),
        "remote_support": ("rustdesk_repaired", "rustdesk_updated", "sync_failed"),
        "assignments": ("assignment_changed", "device_regrouped"),
    }
    for section, types in event_types.items():
        if section not in wanted:
            continue
        query = db.query(DeviceActivityEvent).filter(
            DeviceActivityEvent.device_id == device.id,
            DeviceActivityEvent.occurred_at >= start,
            DeviceActivityEvent.occurred_at < end,
            DeviceActivityEvent.event_type.in_(types),
        )
        events, truncated = _rows(query, DeviceActivityEvent.occurred_at)
        note = _retention_note(section, start, now)
        if section == "user_activity":
            rows = []
            for event in events:
                previous = (event.detail or "").removeprefix("Previous: ") if (event.detail or "").startswith("Previous: ") else "Unknown"
                current = event.summary.removeprefix("User changed to ") if event.summary.startswith("User changed to ") else "Unknown"
                rows.append([_time(event.occurred_at), _safe(previous), _safe(current), _safe(event.actor or "agent")])
            sections[section] = _section(["Timestamp", "Previous user", "New user", "Source"], rows, note + " Existing events store values as display text; unknown values are marked.", truncated)
        else:
            sections[section] = _section(["Timestamp", "Event", "Detail", "Source"], [
                [_time(e.occurred_at), _safe(e.summary), _safe(e.detail), _safe(e.actor)] for e in events
            ], note, truncated)

    if "health" in wanted:
        current = ["Current snapshot", f"{health_state} ({health_score})", ", ".join(health_reasons), "system"]
        sections["health"]["rows"].insert(0, current)
        health_alerts = db.query(DeviceAlert).filter(
            DeviceAlert.device_id == device.id, DeviceAlert.created_at >= start,
            DeviceAlert.created_at < end,
            DeviceAlert.kind.in_(("high_cpu", "high_ram", "low_disk")),
        ).order_by(DeviceAlert.created_at.asc()).limit(_ROW_LIMIT).all()
        sections["health"]["rows"].extend([
            [_time(a.created_at), _safe(a.message), _text(a.severity), "alert"] for a in health_alerts
        ])
        sections["health"]["note"] += " Current score is a snapshot; CPU/RAM/disk alert rows are shown, not raw telemetry."

    if "status_uptime" in wanted:
        query = db.query(DeviceStatusHistory).filter(DeviceStatusHistory.device_id == device.id, DeviceStatusHistory.created_at >= start, DeviceStatusHistory.created_at < end)
        history, truncated = _rows(query, DeviceStatusHistory.created_at)
        sections["status_uptime"] = _section(["Timestamp", "Previous", "New", "Reason"], [
            [_time(s.created_at), _text(s.previous_status), _text(s.new_status), _safe(s.reason)] for s in history
        ], _retention_note("status_uptime", start, now) + " Exact uptime percentage is unavailable when the state at range start is unknown. Current status: " + _text(device.status) + ".", truncated)
        latest_telemetry = db.query(DeviceTelemetry).filter(DeviceTelemetry.device_id == device.id).order_by(DeviceTelemetry.created_at.desc()).first()
        if latest_telemetry and latest_telemetry.uptime_seconds is not None:
            sections["status_uptime"]["note"] += f" Latest reported device uptime: {latest_telemetry.uptime_seconds} seconds at {_time(latest_telemetry.created_at)}."

    if "alerts" in wanted:
        query = db.query(DeviceAlert).filter(DeviceAlert.device_id == device.id, or_(
            (DeviceAlert.created_at >= start) & (DeviceAlert.created_at < end),
            (DeviceAlert.resolved_at >= start) & (DeviceAlert.resolved_at < end),
        ))
        alerts, truncated = _rows(query, func.coalesce(DeviceAlert.resolved_at, DeviceAlert.created_at))
        sections["alerts"] = _section(["Opened", "Severity", "Kind", "Current state", "Resolved", "Message"], [
            [_time(a.created_at), _text(a.severity), _text(a.kind), _text(a.state), _time(a.resolved_at), _safe(a.message)] for a in alerts
        ], _retention_note("alerts", start, now) + " Includes alerts opened or resolved in the period; state is current.", truncated)

    if "actions" in wanted:
        query = db.query(RemoteAction).filter(RemoteAction.device_id == device.id, RemoteAction.created_at >= start, RemoteAction.created_at < end)
        actions, truncated = _rows(query, RemoteAction.created_at)
        sections["actions"] = _section(["Queued", "Action", "Current state", "Operator", "Completed", "Failed"], [
            [_time(a.queued_at or a.created_at), _safe(a.action_type), _text(a.status), _safe(a.created_by), _time(a.completed_at), _time(a.failed_at)] for a in actions
        ], _retention_note("actions", start, now) + " Action payload and command output are excluded.", truncated)

    if "software" in wanted:
        inventory = db.query(DeviceInventory).filter(DeviceInventory.device_id == device.id).first()
        try:
            packages = json.loads(inventory.software_json) if inventory and inventory.software_json else []
            packages = packages if isinstance(packages, list) else []
        except (ValueError, TypeError):
            packages = []
        rows = [[_safe(p.get("name")), _safe(p.get("version")), _safe(p.get("publisher"))] for p in packages[:_ROW_LIMIT] if isinstance(p, dict)]
        collected = _time(inventory.collected_at) if inventory else "never"
        sections["software"] = _section(["Name", "Version", "Publisher"], rows, f"Current inventory collected {collected}. Install/remove history is not recorded.", len(packages) > _ROW_LIMIT)

    if "remote_support" in wanted:
        current = [["Current status", _safe(device.rustdesk_status)], ["Install status", _safe(device.rustdesk_install_status)], ["Version", _safe(device.rustdesk_version)], ["Last seen", _time(device.rustdesk_last_seen_at)]]
        events_section = sections.get("remote_support")
        events_rows = events_section["rows"] if events_section else []
        sections["remote_support"] = _section(["Timestamp / field", "Event / value", "Detail", "Source"], [[row[0], row[1], "", ""] for row in current] + events_rows, (events_section or {}).get("note", "") + " Current status is a snapshot; complete status history is not stored.")

    if "notes" in wanted:
        query = db.query(DeviceNote).filter(DeviceNote.device_id == device.id, DeviceNote.created_at >= start, DeviceNote.created_at < end)
        notes, truncated = _rows(query, DeviceNote.created_at)
        sections["notes"] = _section(["Created", "Author", "Note"], [
            [_time(n.created_at), _safe(n.created_by), _safe(n.note)] for n in notes
        ], "Current note text is shown. Deleted notes and earlier versions are unavailable.", truncated)

    if "event_history" in wanted:
        query = db.query(DeviceActivityEvent).filter(
            DeviceActivityEvent.device_id == device.id, DeviceActivityEvent.occurred_at >= start,
            DeviceActivityEvent.occurred_at < end,
            DeviceActivityEvent.event_type != "heartbeat_received",
        )
        events, truncated = _rows(query, DeviceActivityEvent.occurred_at)
        sections["event_history"] = _section(["Timestamp", "Type", "Event", "Detail", "Actor"], [
            [_time(e.occurred_at), _safe(e.event_type), _safe(e.summary), _safe(e.detail), _safe(e.actor)] for e in events
        ], _retention_note("event_history", start, now) + " This is the persisted event table, excluding heartbeat markers; other sections may repeat these events.", truncated)

    def count(key):
        return len(sections.get(key, {}).get("rows", []))

    if report_type == "full":
        alert_total = db.query(func.count(DeviceAlert.id)).filter(DeviceAlert.device_id == device.id, or_(
            (DeviceAlert.created_at >= start) & (DeviceAlert.created_at < end),
            (DeviceAlert.resolved_at >= start) & (DeviceAlert.resolved_at < end),
        )).scalar() or 0
        offline_total = db.query(func.count(DeviceStatusHistory.id)).filter(
            DeviceStatusHistory.device_id == device.id, DeviceStatusHistory.created_at >= start,
            DeviceStatusHistory.created_at < end, DeviceStatusHistory.new_status == DeviceStatus.OFFLINE,
        ).scalar() or 0
        action_total = db.query(func.count(RemoteAction.id)).filter(
            RemoteAction.device_id == device.id, RemoteAction.created_at >= start,
            RemoteAction.created_at < end,
        ).scalar() or 0
        user_total = db.query(func.count(DeviceActivityEvent.id)).filter(
            DeviceActivityEvent.device_id == device.id, DeviceActivityEvent.occurred_at >= start,
            DeviceActivityEvent.occurred_at < end, DeviceActivityEvent.event_type == "user_changed",
        ).scalar() or 0
    else:
        alert_total, offline_total, action_total, user_total = count("alerts"), 0, count("actions"), count("user_activity")

    return {
        "device_id": device.id, "device_name": device.display_name or device.hostname or f"Device #{device.id}",
        "client_name": client_name, "report_type": report_type, "start": start, "end": end,
        "generated_at": now, "generated_by": generated_by, "sections": sections,
        "summary": {
            "status": _text(device.status), "health": f"{health_state} ({health_score})",
            "current_user": _safe(device.current_user), "last_seen": _time(device.last_seen),
            "alerts": alert_total, "offline_events": offline_total,
            "actions": action_total, "user_changes": user_total,
        },
        "health_reasons": health_reasons,
    }


def device_csv(snapshot: dict) -> bytes:
    section = snapshot["sections"][snapshot["report_type"]]
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["TECHI Device Report", _csv_cell(snapshot["device_name"]), snapshot["device_id"]])
    writer.writerow(["Type", SECTION_TITLES[snapshot["report_type"]]])
    writer.writerow(["Period", snapshot["start"].isoformat(), snapshot["end"].isoformat()])
    writer.writerow(["Generated", snapshot["generated_at"].isoformat(), _csv_cell(snapshot["generated_by"])])
    writer.writerow(["Note", section["note"].strip()])
    writer.writerow([])
    writer.writerow(section["headers"])
    for row in section["rows"]:
        writer.writerow([_csv_cell(cell) for cell in row])
    return output.getvalue().encode("utf-8-sig")
