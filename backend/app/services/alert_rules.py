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
)
