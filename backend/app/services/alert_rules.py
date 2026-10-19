from dataclasses import dataclass

from app.models.alert import AlertKind, AlertSeverity


@dataclass(frozen=True)
class AlertRule:
    severity: AlertSeverity
    cooldown_seconds: int


ALERT_RULES: dict[AlertKind, AlertRule] = {
    AlertKind.DEVICE_OFFLINE: AlertRule(severity=AlertSeverity.CRITICAL, cooldown_seconds=300),
    AlertKind.REPEATED_RECONNECTS: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=600),
    AlertKind.HIGH_CPU: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=300),
    AlertKind.HIGH_RAM: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=300),
    AlertKind.LOW_DISK: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=1800),
    AlertKind.RUSTDESK_SYNC_FAILURE: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=600),
    AlertKind.HEARTBEAT_STALE: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=300),
    AlertKind.TELEMETRY_MISSING: AlertRule(severity=AlertSeverity.INFO, cooldown_seconds=3600),
    # Cooldown of 3600s prevents spam when an archived device sends frequent heartbeats.
    # The alert stays open (deduped by open-alert check) until the device is restored.
    AlertKind.ARCHIVED_CHECKIN: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=3600),
    AlertKind.DISK_FORECAST: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=86400),
    AlertKind.HIGH_NETWORK: AlertRule(severity=AlertSeverity.INFO, cooldown_seconds=600),
    AlertKind.DISK_BUSY: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=1800),
    AlertKind.NETWORK_LATENCY: AlertRule(severity=AlertSeverity.INFO, cooldown_seconds=1800),
    AlertKind.PACKET_LOSS: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=1800),
    AlertKind.SERVICE_STOPPED: AlertRule(severity=AlertSeverity.CRITICAL, cooldown_seconds=300),
    # Health reports arrive hourly: a disk or an event log does not change
    # minute to minute, so a closed alert does not reopen within the day.
    AlertKind.DISK_HEALTH: AlertRule(severity=AlertSeverity.CRITICAL, cooldown_seconds=86400),
    AlertKind.CRITICAL_EVENTS: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=3600),
    AlertKind.REBOOT_PENDING: AlertRule(severity=AlertSeverity.INFO, cooldown_seconds=86400),
    AlertKind.SECURITY_POSTURE: AlertRule(severity=AlertSeverity.WARNING, cooldown_seconds=21600),
}

# CPU and memory alert only on sustained load. A single sample above the line
# opened ~1,550 CPU/RAM alerts a day, most closing within ten minutes (spikes;
# Windows routinely sits above 80% memory). Measured on 24 h of production
# telemetry (2026-10-11): 3 consecutive samples (~15 min at the 300 s
# heartbeat) at 85% CPU / 90% RAM leave ~96 a day across ~35 devices.
CPU_WARN = 85.0
CPU_CRIT = 95.0
RAM_WARN = 90.0
RAM_CRIT = 95.0
# Re-measured on 3.5 days of production telemetry (2026-10-14..17, 158
# devices): with 3 samples to open and ONE sample to close, a busy server whose
# 100 ms heartbeat CPU sample jumps 100 → 0 → 100 opened an alert every time it
# dipped once (LogiposSRV-Mensa: 70 alerts of 5 min). Opening after 4 samples
# (~20 min) and closing only after 4 samples below the resolve line gives 118
# CPU alerts instead of 392, at most 9 on one device, and keeps a sustained
# load as one long alert. Agents >= 2.1.29 alert from their own 1-minute
# monitors instead (MonitorAlertService).
SUSTAINED_SAMPLES = 4
RESOLVE_SAMPLES = 4
CPU_RESOLVE_BELOW = 75.0
RAM_RESOLVE_BELOW = 85.0

DISK_WARN = 85.0
DISK_CRIT = 95.0
# A disk alert closes only below this (it opened above 85%): temp files moving
# a disk across 85% opened and closed it over and over (Mag-Bufe1: 15 a week).
DISK_RESOLVE_BELOW = 82.0

RECONNECT_WINDOW_SECONDS = 600
RECONNECT_THRESHOLD = 3

# Alerts that describe live readings. When the device stops reporting they
# describe nothing current, so they close instead of staying open forever.
STALE_WHEN_OFFLINE = (
    AlertKind.HIGH_CPU,
    AlertKind.HIGH_RAM,
    AlertKind.LOW_DISK,
    AlertKind.REPEATED_RECONNECTS,
    AlertKind.HEARTBEAT_STALE,
    AlertKind.TELEMETRY_MISSING,
    AlertKind.DISK_BUSY,
    AlertKind.NETWORK_LATENCY,
    AlertKind.PACKET_LOSS,
)


# ── Priority ────────────────────────────────────────────────────────────────
# Severity weighed by what the device is: a critical alert on a server is the
# one to act on now; the same on a user's PC can wait for the morning.
SERVER_CATEGORIES = ("servers", "hypervisors", "storage", "network")

_PRIORITY = {
    (AlertSeverity.CRITICAL, True): 1,
    (AlertSeverity.CRITICAL, False): 2,
    (AlertSeverity.WARNING, True): 2,
    (AlertSeverity.WARNING, False): 3,
    (AlertSeverity.INFO, True): 4,
    (AlertSeverity.INFO, False): 4,
}
# A problem that came back this many times climbs one priority.
RECURRING_OCCURRENCES = 3
# Within this long a problem that comes back reopens its own row.
REOPEN_WINDOW_SECONDS = 24 * 3600
# An unowned P1 is escalated (notified again) after this long in working hours.
ESCALATE_AFTER_SECONDS = 30 * 60


def priority_for(severity: AlertSeverity, is_server: bool, occurrences: int = 1) -> int:
    value = _PRIORITY.get((AlertSeverity(severity), bool(is_server)), 4)
    if occurrences >= RECURRING_OCCURRENCES and value > 1 and value < 4:
        value -= 1
    return value


def is_server_category(category: str | None) -> bool:
    return (category or "") in SERVER_CATEGORIES


# ── Windows System events (device health report) ────────────────────────────
# The critical-events monitor opens one alert per group, each with its own
# rule. "min_count" occurrences within "window_h" hours open it; on a PC the
# PC rule applies. "severity" None takes the monitor's own severity.
@dataclass(frozen=True)
class EventGroupRule:
    key: str
    title: str
    window_h: int
    min_count: int
    severity: AlertSeverity | None
    pc_window_h: int | None = None
    pc_min_count: int | None = None
    # Escalates to critical on a server or at this many occurrences.
    critical_from: int | None = None


EVENT_GROUPS: dict[str, EventGroupRule] = {
    # Power lost or button held: one on a PC is not a problem, a pattern is.
    "shutdown": EventGroupRule("shutdown", "Unexpected shutdown", 24, 1, None, pc_window_h=24 * 7, pc_min_count=2),
    "bsod": EventGroupRule("bsod", "Blue screen", 24, 1, None, critical_from=2),
    "hardware": EventGroupRule("hardware", "Fatal hardware error", 24, 1, AlertSeverity.CRITICAL),
    "disk_bad": EventGroupRule("disk_bad", "Disk errors", 24, 1, AlertSeverity.CRITICAL),
    # Retries and paging errors are common on USB drives and busy VMs.
    "disk_retry": EventGroupRule("disk_retry", "Disk I/O retried", 24, 3, None),
    "filesystem": EventGroupRule("filesystem", "File system needs repair", 24, 1, None),
}

# (provider, event id) → group. Providers lower-case, as EVENT_CATALOG.
EVENT_GROUP_OF: dict[tuple[str, int], str] = {
    ("microsoft-windows-kernel-power", 41): "shutdown",
    ("eventlog", 6008): "shutdown",
    ("microsoft-windows-wer-systemerrorreporting", 1001): "bsod",
    ("bugcheck", 1001): "bsod",
    ("microsoft-windows-whea-logger", 18): "hardware",
    ("disk", 7): "disk_bad",
    ("disk", 11): "disk_bad",
    ("disk", 51): "disk_retry",
    ("disk", 153): "disk_retry",
    ("ntfs", 55): "filesystem",
    ("microsoft-windows-ntfs", 55): "filesystem",
    ("ntfs", 98): "filesystem",
    ("microsoft-windows-ntfs", 98): "filesystem",
    ("ntfs", 137): "filesystem",
    ("microsoft-windows-ntfs", 137): "filesystem",
}
# Kernel-Power 41 and EventLog 6008 written at the same boot are one shutdown.
SAME_INCIDENT_SECONDS = 600
