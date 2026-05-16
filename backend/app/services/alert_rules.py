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
}

CPU_WARN = 75.0
CPU_CRIT = 90.0
RAM_WARN = 80.0
RAM_CRIT = 90.0
DISK_WARN = 85.0
DISK_CRIT = 95.0

RECONNECT_WINDOW_SECONDS = 600
RECONNECT_THRESHOLD = 3
