"""Plain words for an alert: a title, a one-line summary and the measured value.

The stored message keeps the hostname the device had when the alert opened
and is written for logs; the console shows the device in its own column, so
the alert is described without it. One place, so the list, the panel, the
notifications and the AI context say the same thing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from app.services.alert_rules import EVENT_GROUPS

KIND_TITLES = {
    "device_offline": "Device offline",
    "repeated_reconnects": "Connection keeps dropping",
    "high_cpu": "High CPU",
    "high_ram": "High memory",
    "low_disk": "Low disk space",
    "disk_forecast": "Disk will fill up",
    "high_network": "High network traffic",
    "rustdesk_sync_failure": "Remote Support sync failed",
    "heartbeat_stale": "Heartbeats arriving late",
    "telemetry_missing": "No telemetry",
    "archived_checkin": "Archived device checked in",
    "disk_busy": "Disk busy",
    "network_latency": "Slow network",
    "packet_loss": "Packet loss",
    "service_stopped": "Service stopped",
    "disk_health": "Disk failing",
    "critical_events": "Critical Windows events",
    "reboot_pending": "Restart pending",
    "security_posture": "Protection turned off",
    "token_usage_warning": "Enrollment token nearly used up",
    "token_usage_critical": "Enrollment token used up",
    "site_outage": "Site offline",
}

_NOW = re.compile(r"\(now ([^)]+)\)\s*$")
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_TIMES = re.compile(r"(\d+)\s*×")
_COUNT = re.compile(r": (\d+) times? in ([^ ]+ [a-z]+)")


@dataclass(frozen=True)
class AlertText:
    title: str
    summary: str
    value: Optional[str]


def _after_colon(message: str) -> str:
    return message.split(": ", 1)[1].strip() if ": " in message else message


def describe_alert(kind: str, fingerprint: str, message: str, detail: Optional[str], severity: str) -> AlertText:
    kind = getattr(kind, "value", kind)
    severity = getattr(severity, "value", severity)
    fingerprint = fingerprint or ""
    message = message or ""
    now = _NOW.search(message)
    value = now.group(1) if now else None

    if kind == "critical_events" and fingerprint.startswith("evt:"):
        group = EVENT_GROUPS.get(fingerprint[4:])
        title = group.title if group else "Critical Windows events"
        count = _COUNT.search(message)
        summary = f"{count.group(1)}× in {count.group(2)}" if count else (detail or "").split(";")[0]
        last = re.search(r"last ([0-9]{2} [A-Z][a-z]{2} [0-9:]{5}) UTC", detail or "")
        if last:
            summary = f"{summary} · last {last.group(1)} UTC"
        return AlertText(title, summary, f"{count.group(1)}×" if count else None)
    if kind == "critical_events":
        # Opened before event groups existed.
        return AlertText("Critical Windows events", _after_colon(message), None)
    if kind in ("high_cpu", "high_ram"):
        label = "CPU" if kind == "high_cpu" else "Memory"
        if value is None:
            percent = _PERCENT.findall(message)
            value = f"{percent[-1]}%" if percent else None
        rule = re.search(r"above ([0-9.]+%) for ([0-9]+ min)", message)
        summary = f"{label} above {rule.group(1)} for {rule.group(2)}" if rule else f"{label} {'critical' if severity == 'critical' else 'elevated'}"
        return AlertText(KIND_TITLES[kind], summary, value)
    if kind == "low_disk":
        volume = fingerprint[4:] if fingerprint.startswith("vol:") else None
        if value is None:
            percent = _PERCENT.findall(message)
            value = f"{percent[-1]}%" if percent else None
        title = f"Disk {volume} almost full" if volume else KIND_TITLES[kind]
        return AlertText(title, message.split(" on ")[0], value)
    if kind == "service_stopped":
        name = _after_colon(message)
        return AlertText(f"Service stopped · {name}", "Set to start automatically", None)
    if kind == "security_posture":
        if fingerprint.startswith("regress:"):
            return AlertText("Protection turned off", _after_colon(message), None)
        return AlertText("Security score low", (detail or "").split(" · ")[0] or message, None)
    if kind == "repeated_reconnects":
        times = _TIMES.search(message)
        return AlertText(KIND_TITLES[kind], "Reconnected several times in 10 minutes", f"{times.group(1)}×" if times else None)
    if kind == "disk_health":
        return AlertText(KIND_TITLES[kind], _after_colon(message.split(" on ")[0]) if ": " in message else message, None)
    if kind == "reboot_pending":
        days = re.search(r"for (\d+) days", message)
        return AlertText(KIND_TITLES[kind], (detail or "").split(" · ")[0] or message, f"{days.group(1)} d" if days else None)
    if kind == "device_offline":
        return AlertText(KIND_TITLES[kind], (detail or message).split(" · ")[0], None)
    if kind == "rustdesk_sync_failure":
        return AlertText(KIND_TITLES[kind], (detail or "Remote Support could not sync").strip(), None)
    title = KIND_TITLES.get(kind, kind.replace("_", " ").capitalize())
    summary = message.split(" on ")[0] if " on " in message else message
    return AlertText(title, summary, value)
