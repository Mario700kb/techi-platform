"""Turns monitor state changes into alerts.

Agents from 2.1.29 evaluate their policy's monitors every minute on the
device and report a change (firing / ok) over the live channel at once, and
again in their next telemetry upload. Applying the same state twice changes
nothing: an open alert is not opened again, a closed one not closed again.

The platform evaluates the monitors an agent cannot see: telemetry that stops
arriving while the device is on, and a disk that will fill up (both swept
every five minutes), and — when the device sends a report — its security
score, the health of its physical disks, critical System events and a restart
left pending (agents 2.1.31 / 2.1.33).
"""
import logging
from datetime import timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow, utcnow_naive
from app.models.alert import AlertKind, AlertSeverity
from app.models.device import Device, DeviceStatus
from app.models.telemetry_pipeline import DeviceTelemetryState
from app.schemas.telemetry_pipeline import EffectivePolicy, Monitor, MonitorEvent

logger = logging.getLogger(__name__)

METRIC_KIND = {
    "cpu": AlertKind.HIGH_CPU,
    "mem": AlertKind.HIGH_RAM,
    "disk": AlertKind.LOW_DISK,
    "net_rx_mbps": AlertKind.HIGH_NETWORK,
    "net_tx_mbps": AlertKind.HIGH_NETWORK,
    "disk_forecast_days": AlertKind.DISK_FORECAST,
    "no_data": AlertKind.TELEMETRY_MISSING,
    "disk_busy": AlertKind.DISK_BUSY,
    "gw_ms": AlertKind.NETWORK_LATENCY,
    "gw_loss": AlertKind.PACKET_LOSS,
    "service": AlertKind.SERVICE_STOPPED,
    "disk_health": AlertKind.DISK_HEALTH,
    "critical_events": AlertKind.CRITICAL_EVENTS,
    "reboot_pending_days": AlertKind.REBOOT_PENDING,
    "security_score": AlertKind.SECURITY_POSTURE,
}
LABEL = {
    "cpu": "CPU", "mem": "Memory", "disk": "Disk", "net_rx_mbps": "Network receive",
    "net_tx_mbps": "Network send", "disk_forecast_days": "Disk", "no_data": "Telemetry",
    "disk_busy": "Disk activity", "gw_ms": "Gateway latency", "gw_loss": "Packet loss", "service": "Service",
    "disk_health": "Disk health", "critical_events": "Critical events", "reboot_pending_days": "Restart",
    "security_score": "Security score",
}
UNIT = {
    "cpu": "%", "mem": "%", "disk": "%", "net_rx_mbps": " Mb/s", "net_tx_mbps": " Mb/s", "disk_forecast_days": " days",
    "disk_busy": "%", "gw_ms": " ms", "gw_loss": "%",
}
# The agent that measures disk activity, network quality, services and health.
AGENT_METRICS_SINCE = (2, 1, 33)


def _minutes(seconds: int) -> str:
    minutes = seconds // 60
    return f"{minutes} min" if minutes else f"{seconds} s"


def describe(monitor: Monitor) -> str:
    """Plain words for a rule: "above 95% for 15 min"."""
    if monitor.metric == "no_data":
        return f"no data for {max(1, monitor.duration_s // 60)} min while on"
    if monitor.metric == "disk_forecast_days":
        return f"full within {int(monitor.threshold)} days"
    if monitor.metric == "service":
        rule = f"stopped for {_minutes(monitor.duration_s)}" if monitor.duration_s else "stopped"
        return f"{rule} · {monitor.target}" if monitor.target else rule
    if monitor.metric == "disk_health":
        return "a disk reports a problem"
    if monitor.metric == "critical_events":
        return "any in 24 h" if monitor.threshold <= 0 else f"more than {monitor.threshold:g} in 24 h"
    if monitor.metric == "reboot_pending_days":
        return f"pending over {monitor.threshold:g} days"
    if monitor.metric == "security_score":
        return f"below {monitor.threshold:g}"
    word = "above" if monitor.op == ">" else "below"
    unit = UNIT.get(monitor.metric, "")
    rule = f"{word} {monitor.threshold:g}{unit}"
    if monitor.duration_s:
        rule += f" for {_minutes(monitor.duration_s)}"
    return rule


class MonitorAlertService:
    def __init__(self, db: Session):
        self.db = db

    def _engine(self):
        from app.services.alert_engine import AlertEngine

        return AlertEngine(self.db)

    def apply(self, device: Device, event: MonitorEvent, policy: EffectivePolicy) -> None:
        monitor = next((m for m in policy.monitors if m.key == event.key), None)
        if monitor is None or not monitor.enabled:
            return  # the policy changed since the agent evaluated it
        kind = METRIC_KIND.get(monitor.metric)
        if kind is None:
            return
        engine = self._engine()
        if event.state == "ok" or (monitor.metric == "disk" and self._small_volume(device.id, event.target)):
            # A small volume (recovery, EFI) full is not a problem; agents
            # before 2.1.33 still report it.
            engine._resolve(device.id, kind, reason=f"monitor_{monitor.key}_ok")
            return
        hostname = device.display_name or device.hostname or f"device-{device.id}"
        if monitor.metric == "service":
            stopped = event.target or monitor.target or "a watched service"
            duration = f" for {_minutes(monitor.duration_s)}" if monitor.duration_s else ""
            engine._open_alert(
                device.id, kind, AlertSeverity(monitor.severity),
                f"Service stopped{duration} on {hostname}: {stopped}"[:512],
                detail=f"Monitor {monitor.key} · set to start automatically · reported by the device",
                device=device,
            )
            return
        label = LABEL.get(monitor.metric, monitor.metric)
        if event.target:
            label = f"{label} {event.target}"
        now = ""
        if event.value is not None:
            now = f" (now {event.value:.0f}{UNIT.get(monitor.metric, '')})"
        engine._open_alert(
            device.id,
            kind,
            AlertSeverity(monitor.severity),
            f"{label} {describe(monitor)} on {hostname}{now}",
            detail=f"Monitor {monitor.key} · reported by the device",
            device=device,
        )

    def _small_volume(self, device_id: int, mount: Optional[str]) -> bool:
        if not mount:
            return False
        from app.models.telemetry_pipeline import TelemetrySample
        from app.services.telemetry_ingest_service import SMALL_VOLUME_GB

        latest = (
            self.db.query(TelemetrySample.disks)
            .filter(TelemetrySample.device_id == device_id, TelemetrySample.disks.isnot(None))
            .order_by(TelemetrySample.ts.desc())
            .first()
        )
        for disk in (latest[0] if latest else None) or []:
            if str(disk.get("mount", "")).upper() == mount.upper():
                total = disk.get("total_gb")
                return total is not None and total < SMALL_VOLUME_GB
        return False

    # ── reports: security posture and device health ─────────────────────────

    def evaluate_reports(self, device: Device) -> None:
        """Judge the device's last security posture and health report against
        its policy. Called when a heartbeat brings either; each report is
        re-sent at least every six hours, so an alert also closes on its own."""
        from app.services.device_health import alerting_events, disks_with_problems, reboot_pending_days
        from app.services.device_inventory_service import DeviceInventoryService
        from app.services.monitoring_policy_service import effective_policy
        from app.services.security_posture import posture_findings, posture_score

        policy = effective_policy(self.db, device)
        monitors = {m.metric: m for m in policy.monitors if m.enabled}
        wanted = [m for m in ("security_score", "disk_health", "critical_events", "reboot_pending_days") if m in monitors]
        if not wanted:
            return
        inventory = DeviceInventoryService(self.db)
        hostname = device.display_name or device.hostname or f"device-{device.id}"
        engine = self._engine()
        now = utcnow()

        def judge(metric: str, firing: bool, message: str, detail: str) -> None:
            monitor = monitors[metric]
            kind = METRIC_KIND[metric]
            if not firing:
                engine._resolve(device.id, kind, reason=f"monitor_{monitor.key}_ok")
                return
            engine._open_alert(device.id, kind, AlertSeverity(monitor.severity), message[:512],
                               detail=f"{detail} · monitor {monitor.key}"[:1024], device=device)

        if "security_score" in monitors:
            posture = inventory.get_security_posture(device.id)
            if posture is not None:
                monitor = monitors["security_score"]
                score = posture_score(posture)
                findings = [text for _, text in posture_findings(posture)]
                judge("security_score", score < monitor.threshold,
                      f"Security score below {monitor.threshold:g} on {hostname} (now {score})",
                      "; ".join(findings) or "No known problem")

        health = inventory.get_health(device.id) if {"disk_health", "critical_events", "reboot_pending_days"} & set(monitors) else None
        if health is None:
            return
        if "disk_health" in monitors:
            problems = disks_with_problems(health)
            judge("disk_health", bool(problems),
                  f"Disk health: {problems[0].name} — {problems[0].problem} on {hostname}" if problems else "",
                  "; ".join(f"{d.name}: {d.problem}" for d in problems))
        if "critical_events" in monitors:
            monitor = monitors["critical_events"]
            events = alerting_events(health, now)
            titles = []
            for e in events[:5]:
                titles.append(f"{e.title} ({e.source} {e.event_id}) {e.at:%d %b %H:%M} UTC")
            count = len(events)
            judge("critical_events", count > monitor.threshold,
                  f"{count} critical event{'s' if count != 1 else ''} in 24 h on {hostname}: {events[0].title if events else ''}",
                  "; ".join(titles))
        if "reboot_pending_days" in monitors:
            monitor = monitors["reboot_pending_days"]
            days = reboot_pending_days(health, now)
            from app.schemas.device_health import REBOOT_REASONS

            reasons = ", ".join(REBOOT_REASONS.get(r, r) for r in health.reboot_reasons) or "Windows"
            judge("reboot_pending_days", days is not None and days > monitor.threshold,
                  f"Restart pending for {days:.0f} days on {hostname}" if days is not None else "",
                  f"Waiting for: {reasons}")

    # ── server-side monitors ────────────────────────────────────────────────

    def sweep(self) -> int:
        """No data while on, and disks that will fill up, for devices whose
        agent uploads telemetry. Returns the number of alerts touched."""
        from app.services.metrics_query_service import disk_trends
        from app.services.monitoring_policy_service import effective_policy

        touched = 0
        now = utcnow_naive()
        states = self.db.query(DeviceTelemetryState).all()
        engine = self._engine()
        for state in states:
            device = self.db.get(Device, state.device_id)
            if device is None or device.is_archived:
                continue
            policy = effective_policy(self.db, device)
            monitors = {m.metric: m for m in policy.monitors if m.enabled}

            no_data = monitors.get("no_data")
            if no_data is not None:
                silent_for = (now - state.last_upload_at) if state.last_upload_at else None
                limit = timedelta(seconds=policy.upload_seconds * 2 + no_data.duration_s)
                online = device.status == DeviceStatus.ONLINE
                if online and silent_for is not None and silent_for > limit:
                    self.apply(device, MonitorEvent(key=no_data.key, state="firing"), policy)
                    touched += 1
                elif silent_for is not None and silent_for <= limit:
                    engine._resolve(device.id, AlertKind.TELEMETRY_MISSING, reason="telemetry_arriving")

            forecast = monitors.get("disk_forecast_days")
            if forecast is not None:
                worst: Optional[tuple] = None
                for disk in disk_trends(self.db, device.id):
                    if disk.days_to_full is not None and (worst is None or disk.days_to_full < worst[0]):
                        worst = (disk.days_to_full, disk.mount)
                if worst is not None and worst[0] < forecast.threshold:
                    self.apply(device, MonitorEvent(key=forecast.key, state="firing", value=worst[0], target=worst[1]), policy)
                    touched += 1
                else:
                    engine._resolve(device.id, AlertKind.DISK_FORECAST, reason="disk_forecast_ok")
        return touched
