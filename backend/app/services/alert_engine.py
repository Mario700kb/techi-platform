import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.alert import AlertKind, AlertSeverity, DeviceAlert
from app.repositories.alert_repository import AlertRepository
from app.services.device_maintenance_service import is_maintenance_active
from app.repositories.device_telemetry_repository import DeviceTelemetryRepository
from app.services.alert_rules import (
    ALERT_RULES,
    RECURRING_OPENINGS,
    RECURRING_WINDOW_SECONDS,
    REOPEN_WINDOW_SECONDS,
    is_server_category,
    priority_for,
    CPU_CRIT,
    CPU_WARN,
    DISK_CRIT,
    DISK_WARN,
    RAM_CRIT,
    RAM_WARN,
    RECONNECT_THRESHOLD,
    CPU_RESOLVE_BELOW,
    DISK_RESOLVE_BELOW,
    RAM_RESOLVE_BELOW,
    RESOLVE_SAMPLES,
    STALE_WHEN_OFFLINE,
    SUSTAINED_SAMPLES,
)
from app.services.alert_incidents import attach as attach_to_incident
from app.services.alert_sla import deadline_fields, restamp as restamp_sla
from app.services.notification_events import NotificationEvent
from app.services.notification_service import NotificationService
from app.websocket.events import RealtimeEventType, build_event
from app.websocket.publisher import realtime_publisher
from app.core.time import utcnow_naive

logger = logging.getLogger(__name__)


def _alert_payload(alert: DeviceAlert) -> dict:
    return {
        "id": alert.id,
        "device_id": alert.device_id,
        "kind": getattr(alert.kind, "value", alert.kind),
        "severity": getattr(alert.severity, "value", alert.severity),
        "state": getattr(alert.state, "value", alert.state),
        "message": alert.message,
        "detail": alert.detail,
        "created_at": alert.created_at.isoformat(),
        "updated_at": alert.updated_at.isoformat(),
        "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
        "fingerprint": alert.fingerprint or "",
        "occurrences": alert.occurrences or 1,
        "priority": alert.priority,
    }


_SEVERITY_RANK = {AlertSeverity.INFO: 0, AlertSeverity.WARNING: 1, AlertSeverity.CRITICAL: 2}


def _rank(severity) -> int:
    return _SEVERITY_RANK.get(AlertSeverity(getattr(severity, "value", severity)), 0)


def device_is_server(device) -> bool:
    """Servers, hypervisors, storage and network gear weigh more than a PC."""
    if device is None:
        return False
    try:
        from app.platform_core.classification import classify_category

        return is_server_category(classify_category(device))
    except Exception:
        logger.debug("classify_category failed for device %s", getattr(device, "id", None), exc_info=True)
        product = getattr(device, "windows_product_type", None)
        return product in (2, 3)


class AlertEngine:
    def __init__(self, db: Session):
        self.repo = AlertRepository(db)
        # A device's open alerts, when prefetched (the heartbeat does): a kind
        # that is not open needs no lookup to know there is nothing to close.
        # Six such lookups per heartbeat were the most frequent query in
        # production, almost always empty.
        self._open: Optional[dict] = None
        self._open_device: Optional[int] = None
        self._mutes: Optional[list] = None

    def prefetch_open(self, device_id: int) -> list:
        alerts = self.repo.list_open_for_device(device_id)
        self._open_device = device_id
        self._open = {(alert.kind, alert.fingerprint or ""): alert for alert in alerts}
        return alerts

    def _prefetched(self, device_id: int) -> bool:
        return self._open is not None and self._open_device == device_id

    def _known_closed(self, device_id: int, kind: AlertKind, fingerprint: str = "") -> bool:
        return self._prefetched(device_id) and (kind, fingerprint or "") not in self._open

    def _kind_known_closed(self, device_id: int, kind: AlertKind) -> bool:
        return self._prefetched(device_id) and not any(k == kind for k, _ in self._open)

    def _get_open(self, device_id: int, kind: AlertKind, fingerprint: str) -> Optional[DeviceAlert]:
        if self._prefetched(device_id):
            return self._open.get((kind, fingerprint))
        return self.repo.get_open(device_id, kind, fingerprint)

    def _muted(self, device, kind: AlertKind, fingerprint: str) -> bool:
        if self._mutes is None:
            self._mutes = self.repo.active_mutes()
        if not self._mutes:
            return False
        device_id = getattr(device, "id", None)
        client_id = getattr(device, "client_id", None)
        for mute in self._mutes:
            if mute.device_id is not None and mute.device_id != device_id:
                continue
            if mute.client_id is not None and mute.client_id != client_id:
                continue
            if mute.kind and mute.kind != kind.value:
                continue
            if mute.fingerprint and mute.fingerprint != fingerprint:
                continue
            return True
        return False

    def _open_alert(
        self,
        device_id: int,
        kind: AlertKind,
        severity: AlertSeverity,
        message: str,
        detail: Optional[str] = None,
        device=None,
        fingerprint: str = "",
        refresh: bool = False,
    ) -> Optional[DeviceAlert]:
        """Open (or reopen) the alert for this device, kind and fingerprint.

        An open one is not opened again: it only climbs to a higher severity
        (waking a "snooze until worse"), and with ``refresh`` takes the new
        wording. One resolved within a day reopens as the same row with its
        count raised; a cooldown still holds it closed."""
        fingerprint = fingerprint or ""
        severity = AlertSeverity(getattr(severity, "value", severity))
        if device is not None and is_maintenance_active(device):
            return None
        existing = self._get_open(device_id, kind, fingerprint)
        if existing is not None:
            self._update_open(existing, severity, message, detail, device, refresh)
            return None
        if device is None:
            from app.models.device import Device

            device = self.repo.db.get(Device, device_id)
        if device is not None and self._muted(device, kind, fingerprint):
            return None
        now = utcnow_naive()
        recent = self.repo.get_most_recent_resolved(device_id, kind, fingerprint)
        if recent is not None and recent.cooldown_until and recent.cooldown_until > now:
            return None
        rule = ALERT_RULES.get(kind)
        cooldown_seconds = rule.cooldown_seconds if rule else 300
        is_server = device_is_server(device)
        recurring = self.repo.openings_within(device_id, kind, fingerprint, RECURRING_WINDOW_SECONDS) + 1 >= RECURRING_OPENINGS
        try:
            if (
                recent is not None
                and recent.resolved_at is not None
                and (now - recent.resolved_at).total_seconds() <= REOPEN_WINDOW_SECONDS
            ):
                occurrences = (recent.occurrences or 1) + 1
                priority = priority_for(severity, is_server, occurrences)
                alert = self.repo.reopen(
                    recent,
                    severity=severity,
                    message=message,
                    detail=detail,
                    priority=priority,
                    sla=deadline_fields(priority, is_server, now),
                    recurring=recurring,
                )
            else:
                priority = priority_for(severity, is_server)
                alert = self.repo.create(
                    device_id=device_id,
                    kind=kind,
                    severity=severity,
                    message=message,
                    detail=detail,
                    cooldown_seconds=cooldown_seconds,
                    fingerprint=fingerprint,
                    priority=priority,
                    sla=deadline_fields(priority, is_server, now),
                    recurring=recurring,
                )
        except Exception:
            logger.exception("Failed to open alert kind=%s device_id=%s", kind, device_id)
            self.repo.db.rollback()
            return None
        if self._prefetched(device_id):
            self._open[(kind, fingerprint)] = alert
        try:
            attach_to_incident(self.repo.db, alert, device)
        except Exception:
            logger.exception("Incident grouping failed for alert id=%s", alert.id)
            self.repo.db.rollback()
        realtime_publisher.publish_threadsafe(
            build_event(RealtimeEventType.ALERT_CREATED, data=_alert_payload(alert), reason="alert_created"),
            dedupe_key=f"alert_created:{alert.id}:{alert.occurrences}",
        )
        # A follower is told through its incident's lead, not once per device.
        if alert.parent_id is None:
            self._notify_opened(alert, device)
        return alert

    def _update_open(self, alert: DeviceAlert, severity: AlertSeverity, message: str, detail, device, refresh: bool) -> None:
        worse = _rank(severity) > _rank(alert.severity)
        if not worse and not (refresh and (alert.message != message or alert.detail != detail)):
            return
        try:
            if worse:
                alert.severity = severity.value
                is_server = device_is_server(device)
                priority = priority_for(severity, is_server, alert.occurrences or 1)
                if alert.priority is not None and priority < alert.priority:
                    # More urgent now: its clock starts again on the tighter deadlines.
                    alert.priority = priority
                    restamp_sla(alert, is_server)
                alert.priority = priority
                if alert.snooze_until_worse:
                    alert.snoozed_until = None
                    alert.snooze_until_worse = False
                self.repo.add_activity(alert.id, "escalated", None, f"Now {severity.value}")
            alert.message = message
            alert.detail = detail
            alert.updated_at = utcnow_naive()
            alert.last_seen_at = alert.updated_at
            self.repo.db.commit()
        except Exception:
            logger.exception("Failed to update alert id=%s", alert.id)
            self.repo.db.rollback()
            return
        if worse:
            self._notify_opened(alert, device)

    def _notify_opened(self, alert: DeviceAlert, device=None) -> None:
        client_id = getattr(device, "client_id", None)
        kind = AlertKind(getattr(alert.kind, "value", alert.kind))
        if kind == AlertKind.DEVICE_OFFLINE and (alert.occurrences or 1) == 1:
            NotificationService(self.repo.db).dispatch(
                event_type=NotificationEvent.DEVICE_OFFLINE,
                title=alert.message,
                message=alert.detail or alert.message,
                severity=getattr(alert.severity, "value", alert.severity),
                device_id=alert.device_id,
                client_id=client_id,
            )
        # Only what has to be acted on now leaves the console: a P1.
        if alert.priority == 1:
            NotificationService(self.repo.db).dispatch(
                event_type=NotificationEvent.CRITICAL_ALERT,
                title=alert.message,
                message=alert.detail or alert.message,
                severity=getattr(alert.severity, "value", alert.severity),
                device_id=alert.device_id,
                client_id=client_id,
                payload={"kind": kind.value, "priority": 1, "alert_id": alert.id},
            )

    def resolve_alert(self, alert: DeviceAlert, reason: str = "resolved", cooldown_seconds: Optional[int] = None) -> Optional[DeviceAlert]:
        """Close one open alert the platform no longer sees."""
        if alert is None or getattr(alert.state, "value", alert.state) != "open":
            return None
        kind = AlertKind(getattr(alert.kind, "value", alert.kind))
        if cooldown_seconds is None:
            rule = ALERT_RULES.get(kind)
            cooldown_seconds = rule.cooldown_seconds if rule else 300
        try:
            resolved = self.repo.resolve(
                alert.id, cooldown_seconds=cooldown_seconds, resolution="auto", resolved_by=None, note=reason
            )
        except Exception:
            logger.exception("Failed to resolve alert id=%s", alert.id)
            self.repo.db.rollback()
            return None
        if resolved:
            if self._prefetched(alert.device_id):
                self._open.pop((kind, alert.fingerprint or ""), None)
            realtime_publisher.publish_threadsafe(
                build_event(RealtimeEventType.ALERT_RESOLVED, data=_alert_payload(resolved), reason=reason),
                dedupe_key=f"alert_resolved:{resolved.id}:{resolved.occurrences}",
            )
        return resolved

    def _resolve(self, device_id: int, kind: AlertKind, reason: str = "resolved", fingerprint: str = "") -> Optional[DeviceAlert]:
        fingerprint = fingerprint or ""
        if self._known_closed(device_id, kind, fingerprint):
            return None
        open_alert = self._get_open(device_id, kind, fingerprint)
        if not open_alert:
            return None
        return self.resolve_alert(open_alert, reason=reason)

    def resolve_kind(self, device_id: int, kind: AlertKind, reason: str, keep: tuple = ()) -> int:
        """Close every open alert of a kind on the device, except the
        fingerprints in ``keep``."""
        if self._kind_known_closed(device_id, kind):
            return 0
        if self._prefetched(device_id):
            alerts = [a for (k, _), a in list(self._open.items()) if k == kind]
        else:
            alerts = self.repo.list_open_for_device_kind(device_id, kind)
        closed = 0
        for alert in alerts:
            if (alert.fingerprint or "") in keep:
                continue
            if self.resolve_alert(alert, reason=reason) is not None:
                closed += 1
        return closed

    def open_offline_alert(
        self, device, *, severity: AlertSeverity, message: str, detail: Optional[str] = None
    ) -> Optional[DeviceAlert]:
        """Opens a device-offline alert. When one is due is decided by
        app/services/offline_alerts.py, not by the offline transition."""
        return self._open_alert(
            device_id=device.id,
            kind=AlertKind.DEVICE_OFFLINE,
            severity=severity,
            message=message,
            detail=detail,
            device=device,
        )

    def resolve_device_offline(self, device) -> None:
        resolved = self._resolve(device.id, AlertKind.DEVICE_OFFLINE, reason="device_came_online")
        if resolved is not None:
            hostname = device.hostname or device.rustdesk_id or f"device-{device.id}"
            NotificationService(self.repo.db).dispatch(
                event_type=NotificationEvent.DEVICE_ONLINE,
                title=f"{hostname} is back online",
                message=f"{hostname} came back online.",
                severity=AlertSeverity.INFO.value,
                device_id=device.id,
                client_id=getattr(device, "client_id", None),
            )

    def evaluate_telemetry(
        self,
        device,
        cpu_percent: Optional[float],
        ram_percent: Optional[float],
        disk_percent: Optional[float],
    ) -> None:
        hostname = device.hostname or f"device-{device.id}"
        recent = None

        window = max(SUSTAINED_SAMPLES, RESOLVE_SAMPLES)

        def latest(attr: str, n: int) -> list:
            # The current sample is stored before alerts are evaluated, so the
            # latest rows include it.
            nonlocal recent
            if recent is None:
                recent = DeviceTelemetryRepository(self.repo.db).get_recent_by_device(device.id, limit=window)
            values = [getattr(sample, attr) for sample in recent[:n]]
            return values if len(values) == n and all(v is not None for v in values) else []

        def sustained(attr: str, threshold: float) -> bool:
            values = latest(attr, SUSTAINED_SAMPLES)
            return bool(values) and all(v > threshold for v in values)

        def settled(attr: str, below: float) -> bool:
            # Closing needs the same patience as opening: one low sample in a
            # busy period does not end it.
            values = latest(attr, RESOLVE_SAMPLES)
            return bool(values) and all(v < below for v in values)

        for kind, attr, label, value, warn, crit, below in (
            (AlertKind.HIGH_CPU, "cpu_percent", "CPU", cpu_percent, CPU_WARN, CPU_CRIT, CPU_RESOLVE_BELOW),
            (AlertKind.HIGH_RAM, "ram_percent", "RAM", ram_percent, RAM_WARN, RAM_CRIT, RAM_RESOLVE_BELOW),
        ):
            if value is None:
                continue
            if value > crit and sustained(attr, crit):
                self._open_alert(device.id, kind, AlertSeverity.CRITICAL, f"{label} critical on {hostname}: {value:.1f}%", device=device)
            elif value > warn and sustained(attr, warn):
                self._open_alert(device.id, kind, AlertSeverity.WARNING, f"{label} elevated on {hostname}: {value:.1f}%", device=device)
            elif value < below and not self._known_closed(device.id, kind) and settled(attr, below):
                self._resolve(device.id, kind, reason=f"{label.lower()}_normalized")

        if disk_percent is not None:
            if disk_percent > DISK_CRIT:
                self._open_alert(device.id, AlertKind.LOW_DISK, AlertSeverity.CRITICAL, f"Disk critical on {hostname}: {disk_percent:.1f}% used", device=device)
            elif disk_percent > DISK_WARN:
                self._open_alert(device.id, AlertKind.LOW_DISK, AlertSeverity.WARNING, f"Disk high on {hostname}: {disk_percent:.1f}% used", device=device)
            elif disk_percent < DISK_RESOLVE_BELOW:
                self._resolve(device.id, AlertKind.LOW_DISK, reason="disk_normalized")

    def evaluate_rustdesk_sync(self, device) -> None:
        if device.rustdesk_sync_state == "failed":
            hostname = device.hostname or f"device-{device.id}"
            self._open_alert(
                device_id=device.id,
                kind=AlertKind.RUSTDESK_SYNC_FAILURE,
                severity=AlertSeverity.WARNING,
                message=f"TECHI Remote Support sync failed on {hostname}",
                detail=device.rustdesk_sync_message,
                device=device,
            )
        else:
            self._resolve(device.id, AlertKind.RUSTDESK_SYNC_FAILURE, reason="sync_recovered")

    def evaluate_reconnect(self, device, drops: int) -> None:
        if drops >= RECONNECT_THRESHOLD:
            hostname = device.hostname or f"device-{device.id}"
            self._open_alert(
                device_id=device.id,
                kind=AlertKind.REPEATED_RECONNECTS,
                severity=AlertSeverity.WARNING,
                message=f"{hostname} lost its connection {drops}× in the last 10 minutes",
                device=device,
            )
        else:
            # This alert used to stay open forever: nothing ever closed it.
            self._resolve(device.id, AlertKind.REPEATED_RECONNECTS, reason="reconnects_settled")

    def resolve_stale_on_offline(self, device) -> None:
        """A device that stops reporting has no current CPU, memory or disk
        reading, so the alerts built on those readings close with it."""
        if self._prefetched(device.id):
            alerts = list(self._open.values())
        else:
            alerts = self.repo.list_open_for_device(device.id)
        for alert in alerts:
            if AlertKind(getattr(alert.kind, "value", alert.kind)) in STALE_WHEN_OFFLINE:
                self.resolve_alert(alert, reason="device_offline")

    def resolve_all_for_device(self, device_id: int, reason: str) -> int:
        """Close every open alert of a device (it was archived)."""
        closed = 0
        for alert in self.repo.list_open_for_device(device_id):
            if self.resolve_alert(alert, reason=reason) is not None:
                closed += 1
        return closed

    def evaluate_archived_checkin(self, device) -> None:
        """
        Fire a warning when an archived device sends a heartbeat.

        - Open: fires once per cooldown window (3600s) while device remains archived.
          Existing open alert suppresses duplicates via _is_suppressed.
        - Resolve: called on the same heartbeat path when device is no longer archived,
          so the alert clears automatically on the first heartbeat after a manual restore.
        """
        if device.is_archived:
            hostname = device.hostname or device.rustdesk_id or f"device-{device.id}"
            self._open_alert(
                device_id=device.id,
                kind=AlertKind.ARCHIVED_CHECKIN,
                severity=AlertSeverity.WARNING,
                message=f"Archived device {hostname} checked in",
                detail="Device is archived but still sending heartbeats. No automatic action has been taken.",
                device=device,
            )
        else:
            self._resolve(device.id, AlertKind.ARCHIVED_CHECKIN, reason="device_restored")
