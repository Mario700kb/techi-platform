import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.alert import AlertKind, AlertSeverity, DeviceAlert
from app.repositories.alert_repository import AlertRepository
from app.services.device_maintenance_service import is_maintenance_active
from app.services.alert_rules import (
    ALERT_RULES,
    CPU_CRIT,
    CPU_WARN,
    DISK_CRIT,
    DISK_WARN,
    RAM_CRIT,
    RAM_WARN,
    RECONNECT_THRESHOLD,
)
from app.services.notification_events import NotificationEvent
from app.services.notification_service import NotificationService
from app.websocket.events import RealtimeEventType, build_event
from app.websocket.publisher import realtime_publisher

logger = logging.getLogger(__name__)


def _alert_payload(alert: DeviceAlert) -> dict:
    return {
        "id": alert.id,
        "device_id": alert.device_id,
        "kind": alert.kind.value,
        "severity": alert.severity.value,
        "state": alert.state.value,
        "message": alert.message,
        "detail": alert.detail,
        "created_at": alert.created_at.isoformat(),
        "updated_at": alert.updated_at.isoformat(),
        "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
    }


class AlertEngine:
    def __init__(self, db: Session):
        self.repo = AlertRepository(db)

    def _is_suppressed(self, device_id: int, kind: AlertKind) -> bool:
        if self.repo.get_open_by_device_and_kind(device_id, kind):
            return True
        recent = self.repo.get_most_recent_resolved(device_id, kind)
        if recent and recent.cooldown_until and recent.cooldown_until > datetime.utcnow():
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
    ) -> Optional[DeviceAlert]:
        if device is not None and is_maintenance_active(device):
            return None
        if self._is_suppressed(device_id, kind):
            return None
        rule = ALERT_RULES.get(kind)
        cooldown_seconds = rule.cooldown_seconds if rule else 300
        try:
            alert = self.repo.create(
                device_id=device_id,
                kind=kind,
                severity=severity,
                message=message,
                detail=detail,
                cooldown_seconds=cooldown_seconds,
            )
        except Exception:
            logger.exception("Failed to create alert kind=%s device_id=%s", kind, device_id)
            return None
        realtime_publisher.publish_threadsafe(
            build_event(RealtimeEventType.ALERT_CREATED, data=_alert_payload(alert), reason="alert_created"),
            dedupe_key=f"alert_created:{alert.id}",
        )
        self._notify_opened(alert, device)
        return alert

    def _notify_opened(self, alert: DeviceAlert, device=None) -> None:
        client_id = getattr(device, "client_id", None)
        if alert.kind == AlertKind.DEVICE_OFFLINE:
            NotificationService(self.repo.db).dispatch(
                event_type=NotificationEvent.DEVICE_OFFLINE,
                title=alert.message,
                message=alert.detail or alert.message,
                severity=alert.severity.value,
                device_id=alert.device_id,
                client_id=client_id,
            )
        if alert.severity == AlertSeverity.CRITICAL:
            NotificationService(self.repo.db).dispatch(
                event_type=NotificationEvent.CRITICAL_ALERT,
                title=alert.message,
                message=alert.detail or alert.message,
                severity=alert.severity.value,
                device_id=alert.device_id,
                client_id=client_id,
                payload={"kind": alert.kind.value},
            )

    def _resolve(self, device_id: int, kind: AlertKind, reason: str = "resolved") -> Optional[DeviceAlert]:
        open_alert = self.repo.get_open_by_device_and_kind(device_id, kind)
        if not open_alert:
            return None
        rule = ALERT_RULES.get(kind)
        cooldown_seconds = rule.cooldown_seconds if rule else 300
        try:
            resolved = self.repo.resolve(open_alert.id, cooldown_seconds=cooldown_seconds)
        except Exception:
            logger.exception("Failed to resolve alert id=%s", open_alert.id)
            return None
        if resolved:
            realtime_publisher.publish_threadsafe(
                build_event(RealtimeEventType.ALERT_RESOLVED, data=_alert_payload(resolved), reason=reason),
                dedupe_key=f"alert_resolved:{resolved.id}",
            )
        return resolved

    def evaluate_device_offline(self, device) -> None:
        hostname = device.hostname or device.rustdesk_id or f"device-{device.id}"
        self._open_alert(
            device_id=device.id,
            kind=AlertKind.DEVICE_OFFLINE,
            severity=AlertSeverity.CRITICAL,
            message=f"{hostname} went offline",
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

        if cpu_percent is not None:
            if cpu_percent > CPU_CRIT:
                self._open_alert(device.id, AlertKind.HIGH_CPU, AlertSeverity.CRITICAL, f"CPU critical on {hostname}: {cpu_percent:.1f}%", device=device)
            elif cpu_percent > CPU_WARN:
                self._open_alert(device.id, AlertKind.HIGH_CPU, AlertSeverity.WARNING, f"CPU elevated on {hostname}: {cpu_percent:.1f}%", device=device)
            else:
                self._resolve(device.id, AlertKind.HIGH_CPU, reason="cpu_normalized")

        if ram_percent is not None:
            if ram_percent > RAM_CRIT:
                self._open_alert(device.id, AlertKind.HIGH_RAM, AlertSeverity.CRITICAL, f"RAM critical on {hostname}: {ram_percent:.1f}%", device=device)
            elif ram_percent > RAM_WARN:
                self._open_alert(device.id, AlertKind.HIGH_RAM, AlertSeverity.WARNING, f"RAM elevated on {hostname}: {ram_percent:.1f}%", device=device)
            else:
                self._resolve(device.id, AlertKind.HIGH_RAM, reason="ram_normalized")

        if disk_percent is not None:
            if disk_percent > DISK_CRIT:
                self._open_alert(device.id, AlertKind.LOW_DISK, AlertSeverity.CRITICAL, f"Disk critical on {hostname}: {disk_percent:.1f}% used", device=device)
            elif disk_percent > DISK_WARN:
                self._open_alert(device.id, AlertKind.LOW_DISK, AlertSeverity.WARNING, f"Disk high on {hostname}: {disk_percent:.1f}% used", device=device)
            else:
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

    def evaluate_reconnect(self, device, recent_online_count: int) -> None:
        if recent_online_count >= RECONNECT_THRESHOLD:
            hostname = device.hostname or f"device-{device.id}"
            self._open_alert(
                device_id=device.id,
                kind=AlertKind.REPEATED_RECONNECTS,
                severity=AlertSeverity.WARNING,
                message=f"{hostname} reconnected {recent_online_count}× in the last 10 minutes",
                device=device,
            )

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
