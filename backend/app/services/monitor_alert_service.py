"""Turns monitor state changes into alerts.

Agents from 2.1.29 evaluate their policy's monitors every minute on the
device and report a change (firing / ok) over the live channel at once, and
again in their next telemetry upload. Applying the same state twice changes
nothing: an open alert is not opened again, a closed one not closed again.

The platform evaluates the monitors an agent cannot see: telemetry that stops
arriving while the device is on, and a disk that will fill up (both swept
every five minutes).
"""
import logging
from datetime import timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow_naive
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
}
LABEL = {
    "cpu": "CPU", "mem": "Memory", "disk": "Disk", "net_rx_mbps": "Network receive",
    "net_tx_mbps": "Network send", "disk_forecast_days": "Disk", "no_data": "Telemetry",
}
UNIT = {"cpu": "%", "mem": "%", "disk": "%", "net_rx_mbps": " Mb/s", "net_tx_mbps": " Mb/s", "disk_forecast_days": " days"}


def describe(monitor: Monitor) -> str:
    """Plain words for a rule: "above 95% for 15 min"."""
    if monitor.metric == "no_data":
        return f"no data for {max(1, monitor.duration_s // 60)} min while on"
    if monitor.metric == "disk_forecast_days":
        return f"full within {int(monitor.threshold)} days"
    word = "above" if monitor.op == ">" else "below"
    unit = UNIT.get(monitor.metric, "")
    rule = f"{word} {monitor.threshold:g}{unit}"
    if monitor.duration_s:
        minutes = monitor.duration_s // 60
        rule += f" for {minutes} min" if minutes else f" for {monitor.duration_s} s"
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
        if event.state == "ok":
            engine._resolve(device.id, kind, reason=f"monitor_{monitor.key}_ok")
            return
        hostname = device.display_name or device.hostname or f"device-{device.id}"
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
