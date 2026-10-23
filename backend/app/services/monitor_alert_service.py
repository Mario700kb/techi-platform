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
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func
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
# Posture findings that, when they appear on a device that had them off,
# open an alert (a protection was switched off). The rest stay findings.
REGRESSION_CODES = ("no_antivirus", "realtime_off", "firewall_off", "uac_off")
# How far back the no-data sweep looks for a device coming online: longer than
# any silence limit a policy can set (2 × an hour's upload + the duration).
CAME_ONLINE_LOOKBACK = timedelta(hours=6)


def settled(events: List[MonitorEvent]) -> List[MonitorEvent]:
    """The events of one upload as they are applied. A firing that a later
    event of the same upload already ended happened while the device could
    not report it live (asleep, starting up, offline) and is over: it is not
    opened only to be closed in the same second."""
    out = []
    for i, event in enumerate(events):
        if event.state == "firing" and any(
            later.key == event.key and later.state == "ok" and (not later.target or later.target == event.target)
            for later in events[i + 1:]
        ):
            continue
        out.append(event)
    return out


def fingerprint_for(metric: str, target: Optional[str]) -> str:
    """What inside the device an alert is about: one alert per service and per
    volume, so a second one is not swallowed by the first."""
    if not target:
        return ""
    if metric == "service":
        return f"svc:{target.strip().lower()}"[:128]
    if metric in ("disk", "disk_busy"):
        return f"vol:{target.strip().upper()}"[:128]
    return ""


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
        if monitor.metric == "service":
            self._apply_services(device, event, monitor, kind, engine)
            return
        fingerprint = fingerprint_for(monitor.metric, event.target)
        if event.state == "ok" and not event.target:
            engine.resolve_kind(device.id, kind, reason=f"monitor_{monitor.key}_ok")
            return
        if event.state == "ok" or (monitor.metric == "disk" and self._small_volume(device.id, event.target)):
            # A small volume (recovery, EFI) full is not a problem; agents
            # before 2.1.33 still report it.
            self._resolve_target(engine, device.id, kind, fingerprint, event.target, f"monitor_{monitor.key}_ok")
            return
        hostname = device.display_name or device.hostname or f"device-{device.id}"
        severity = AlertSeverity(monitor.severity)
        if monitor.metric in ("cpu", "mem") and severity == AlertSeverity.CRITICAL and not self._is_server(device):
            # A busy user PC is slow, not down: it waits for a technician,
            # it does not page one.
            severity = AlertSeverity.WARNING
        label = LABEL.get(monitor.metric, monitor.metric)
        if event.target:
            label = f"{label} {event.target}"
        now = ""
        if event.value is not None:
            now = f" (now {event.value:.0f}{UNIT.get(monitor.metric, '')})"
        engine._open_alert(
            device.id,
            kind,
            severity,
            f"{label} {describe(monitor)} on {hostname}{now}",
            detail=f"Monitor {monitor.key} · reported by the device",
            device=device,
            fingerprint=fingerprint,
        )

    def _apply_services(self, device: Device, event: MonitorEvent, monitor: Monitor, kind: AlertKind, engine) -> None:
        """The agent reports every watched service that is stopped, comma
        separated, in one event ("MSSQL$SAGE, vmms"); "ok" means none is.
        Each stopped service is its own alert."""
        stopped = [] if event.state == "ok" else [t.strip() for t in (event.target or "").split(",") if t.strip()]
        if event.state != "ok" and not stopped:
            stopped = [monitor.target or "a watched service"]
        hostname = device.display_name or device.hostname or f"device-{device.id}"
        duration = f" for {_minutes(monitor.duration_s)}" if monitor.duration_s else ""
        keep = []
        for name in stopped:
            fingerprint = fingerprint_for("service", name)
            keep.append(fingerprint)
            engine._open_alert(
                device.id, kind, AlertSeverity(monitor.severity),
                f"Service stopped{duration} on {hostname}: {name}"[:512],
                detail=f"Monitor {monitor.key} · set to start automatically · reported by the device",
                device=device,
                fingerprint=fingerprint,
            )
        engine.resolve_kind(device.id, kind, reason=f"monitor_{monitor.key}_ok", keep=tuple(keep))

    def _is_server(self, device: Device) -> bool:
        from app.services.alert_engine import device_is_server

        return device_is_server(device)

    @staticmethod
    def _resolve_target(engine, device_id: int, kind: AlertKind, fingerprint: str, target: Optional[str], reason: str) -> None:
        if engine._resolve(device_id, kind, reason=reason, fingerprint=fingerprint) is not None or not fingerprint:
            return
        # Alerts opened before fingerprints carry none: close the old one when
        # its message names this service or volume.
        legacy = engine.repo.get_open(device_id, kind, "")
        if legacy is not None and target and target.lower() in (legacy.message or "").lower():
            engine.resolve_alert(legacy, reason=reason)

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

    def evaluate_reports(self, device: Device, previous_posture=None) -> None:
        """Judge the device's last security posture and health report against
        its policy. Called when a heartbeat brings either; each report is
        re-sent at least every six hours, so an alert also closes on its own.

        A security posture is a finding (the Security view lists it), not an
        incident: an alert opens only when a protection that was on is now
        off. System events open one alert per group (EVENT_GROUPS), each with
        its own rule; a pending restart alerts on servers only."""
        from app.services.device_health import disks_with_problems, firing_event_groups, reboot_pending_days
        from app.services.device_inventory_service import DeviceInventoryService
        from app.services.monitoring_policy_service import effective_policy
        from app.services.security_posture import posture_findings

        policy = effective_policy(self.db, device)
        monitors = {m.metric: m for m in policy.monitors if m.enabled}
        wanted = [m for m in ("security_score", "disk_health", "critical_events", "reboot_pending_days") if m in monitors]
        if not wanted:
            return
        inventory = DeviceInventoryService(self.db)
        hostname = device.display_name or device.hostname or f"device-{device.id}"
        engine = self._engine()
        engine.prefetch_open(device.id)
        now = utcnow()
        is_server = self._is_server(device)

        def judge(metric: str, firing: bool, message: str, detail: str) -> None:
            monitor = monitors[metric]
            kind = METRIC_KIND[metric]
            if not firing:
                engine._resolve(device.id, kind, reason=f"monitor_{monitor.key}_ok")
                return
            engine._open_alert(device.id, kind, AlertSeverity(monitor.severity), message[:512],
                               detail=f"{detail} · monitor {monitor.key}"[:1024], device=device, refresh=True)

        if "security_score" in monitors:
            posture = inventory.get_security_posture(device.id)
            if posture is not None:
                monitor = monitors["security_score"]
                current = dict(posture_findings(posture))
                before = dict(posture_findings(previous_posture)) if previous_posture is not None else None
                firing: list = []
                for code, text in current.items():
                    if code not in REGRESSION_CODES:
                        continue
                    fingerprint = f"regress:{code}"
                    already = engine._get_open(device.id, AlertKind.SECURITY_POSTURE, fingerprint)
                    worse = before is not None and (code not in before or (code == "firewall_off" and before[code] != text))
                    if already is not None or worse:
                        firing.append(fingerprint)
                        engine._open_alert(
                            device.id, AlertKind.SECURITY_POSTURE, AlertSeverity(monitor.severity),
                            f"Protection turned off on {hostname}: {text}"[:512],
                            detail=f"Was on in the previous report · monitor {monitor.key}",
                            device=device, fingerprint=fingerprint, refresh=True,
                        )
                engine.resolve_kind(device.id, AlertKind.SECURITY_POSTURE, reason="posture_finding", keep=tuple(firing))

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
            groups = firing_event_groups(health, now, is_server=is_server, base_severity=monitor.severity)
            for group in groups:
                latest = group.events[0]
                times = "time" if group.count == 1 else "times"
                span = "24 h" if group.window_h <= 24 else f"{group.window_h // 24} days"
                titles = [f"{e.title} ({e.source} {e.event_id}) {e.at:%d %b %H:%M} UTC" for e in group.events[:5]]
                engine._open_alert(
                    device.id, AlertKind.CRITICAL_EVENTS, AlertSeverity(group.severity),
                    f"{group.title}: {group.count} {times} in {span} on {hostname}"[:512],
                    detail=f"{'; '.join(titles)} · last {latest.at:%d %b %H:%M} UTC · monitor {monitor.key}"[:1024],
                    device=device, fingerprint=group.fingerprint, refresh=True,
                )
            engine.resolve_kind(device.id, AlertKind.CRITICAL_EVENTS, reason=f"monitor_{monitor.key}_ok",
                                keep=tuple(g.fingerprint for g in groups))
        if "reboot_pending_days" in monitors:
            monitor = monitors["reboot_pending_days"]
            days = reboot_pending_days(health, now)
            from app.schemas.device_health import REBOOT_REASONS

            reasons = ", ".join(REBOOT_REASONS.get(r, r) for r in health.reboot_reasons) or "Windows"
            # On a PC a pending restart is maintenance (the Findings view), not an alert.
            judge("reboot_pending_days", is_server and days is not None and days > monitor.threshold,
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
        came_online = self._came_online(now - CAME_ONLINE_LOOKBACK)
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
                # Time the device was off or asleep is not silence: a PC that
                # wakes uploads on its next tick, up to 15 minutes later.
                quiet_for = silent_for
                if silent_for is not None and device.id in came_online:
                    quiet_for = min(silent_for, now - came_online[device.id])
                if online and quiet_for is not None and quiet_for > limit:
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

    def _came_online(self, since: datetime) -> Dict[int, datetime]:
        """When each device last came online, for those that did since then."""
        from app.models.device_status_history import DeviceStatusHistory

        rows = (
            self.db.query(DeviceStatusHistory.device_id, func.max(DeviceStatusHistory.created_at))
            .filter(DeviceStatusHistory.new_status == DeviceStatus.ONLINE, DeviceStatusHistory.created_at >= since)
            .group_by(DeviceStatusHistory.device_id)
            .all()
        )
        return {device_id: at for device_id, at in rows}
