from datetime import datetime, timedelta
from app.core.time import ensure_utc, utcnow
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.device import Device, DeviceStatus
from app.repositories.device_repository import DeviceRepository
from app.repositories.device_status_history_repository import DeviceStatusHistoryRepository
from app.websocket.events import RealtimeEventType, build_event, device_payload
from app.websocket.publisher import realtime_publisher


def _get_alert_engine(db):
    from app.services.alert_engine import AlertEngine
    return AlertEngine(db)


class DeviceStatusService:
    def __init__(self, db: Session):
        self.db = db
        self.device_repo = DeviceRepository(db)
        self.history_repo = DeviceStatusHistoryRepository(db)

    def calculate_status(
        self,
        *,
        last_seen: Optional[datetime],
        now: Optional[datetime] = None,
        timeout_seconds: Optional[int] = None,
    ) -> DeviceStatus:
        now = ensure_utc(now or utcnow())
        last_seen = ensure_utc(last_seen)
        timeout = timeout_seconds or settings.HEARTBEAT_TIMEOUT_SECONDS

        if last_seen is None:
            return DeviceStatus.OFFLINE
        if last_seen >= now - timedelta(seconds=timeout):
            return DeviceStatus.ONLINE
        return DeviceStatus.OFFLINE

    def mark_online_from_heartbeat(self, device: Device, reason: str = "heartbeat_received") -> Device:
        previous_status = device.status
        if previous_status != DeviceStatus.ONLINE:
            device.status = DeviceStatus.ONLINE
            device.offline_reason = None
            device.offline_confidence = None
            self.db.add(device)
            self.db.commit()
            self.db.refresh(device)
            self.history_repo.create(
                device_id=device.id,
                previous_status=previous_status,
                new_status=DeviceStatus.ONLINE,
                reason=reason,
            )
            payload = device_payload(device)
            realtime_publisher.publish_threadsafe(
                build_event(RealtimeEventType.DEVICE_ONLINE, data=payload, reason=reason),
                dedupe_key=f"device_online:{device.id}",
            )
            realtime_publisher.publish_threadsafe(
                build_event(RealtimeEventType.DEVICE_UPDATED, data=payload, reason=reason),
                dedupe_key=f"device_updated:{device.id}:{device.status.value}",
            )
            _get_alert_engine(self.db).resolve_device_offline(device)
        return device

    def mark_online_from_channel(self, device: Device) -> Device:
        """The agent opened its live command channel, so it is running now:
        online at once, without waiting for its next heartbeat."""
        device.last_seen = utcnow()
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)
        return self.mark_online_from_heartbeat(device, reason="agent_channel_connected")

    def mark_offline_connection_lost(self, device: Device, disconnected_at: datetime) -> bool:
        """The live channel dropped and did not come back within the grace
        period. Offline unless a heartbeat arrived after the drop (the
        channel can fail while plain HTTPS still works)."""
        if device.status != DeviceStatus.ONLINE:
            return False
        if device.last_seen is not None and ensure_utc(device.last_seen) > ensure_utc(disconnected_at):
            return False
        device.offline_reason = "connection_lost"
        device.offline_confidence = "medium"
        self._transition_offline(device, "agent_channel_lost")
        return True

    def reconcile_stale_devices(self, *, now: Optional[datetime] = None, batch_size: Optional[int] = None) -> int:
        now = ensure_utc(now or utcnow())
        timeout = settings.HEARTBEAT_TIMEOUT_SECONDS
        cutoff = now - timedelta(seconds=timeout)
        stale_devices = self.device_repo.get_online_stale(cutoff, limit=batch_size or settings.RECONCILIATION_BATCH_SIZE)

        from app.websocket.agent_channel import agent_command_channel

        transitioned = 0
        for device in stale_devices:
            # An open live channel means the agent is running even if a
            # heartbeat is late; it goes offline when the channel drops.
            if agent_command_channel.is_connected(device.id):
                continue
            computed_status = self.calculate_status(last_seen=device.last_seen, now=now, timeout_seconds=timeout)
            if computed_status != DeviceStatus.OFFLINE or device.status == DeviceStatus.OFFLINE:
                continue

            # No alert here: OfflineAlertSweep decides when one is due.
            self._transition_offline(device, "heartbeat_timeout_exceeded")
            transitioned += 1

        return transitioned

    def mark_offline_from_power_event(self, device: Device, state: str) -> Device:
        if device.status != DeviceStatus.ONLINE:
            return device
        device.offline_reason = state
        device.offline_confidence = "high"
        if state == "shutdown":
            device.last_shutdown_time = utcnow()
        self._transition_offline(device, f"agent_{state}")
        return device

    def _transition_offline(self, device: Device, reason: str) -> None:
        previous_status = device.status
        device.status = DeviceStatus.OFFLINE
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)
        self.history_repo.create(
            device_id=device.id,
            previous_status=previous_status,
            new_status=DeviceStatus.OFFLINE,
            reason=reason,
        )
        payload = device_payload(device)
        realtime_publisher.publish_threadsafe(
            build_event(RealtimeEventType.DEVICE_OFFLINE, data=payload, reason=reason),
            dedupe_key=f"device_offline:{device.id}",
        )
        realtime_publisher.publish_threadsafe(
            build_event(RealtimeEventType.DEVICE_UPDATED, data=payload, reason=reason),
            dedupe_key=f"device_updated:{device.id}:{device.status.value}",
        )
        _get_alert_engine(self.db).resolve_stale_on_offline(device)
        from app.services.remote_session_service import RemoteSessionService

        RemoteSessionService(self.db).end_if_active(device, reason="device_offline")
