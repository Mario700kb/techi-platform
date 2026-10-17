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
SUSTAINED_SAMPLES = 3
# An open CPU/RAM alert closes only once the value is this far below the
# warning line, so a value hovering at the line does not open and close it.
RESOLVE_HYSTERESIS = 5.0

DISK_WARN = 85.0
DISK_CRIT = 95.0

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
)
