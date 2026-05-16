from datetime import datetime, timedelta
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
        now = now or datetime.utcnow()
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

    def reconcile_stale_devices(self, *, now: Optional[datetime] = None, batch_size: Optional[int] = None) -> int:
        now = now or datetime.utcnow()
        timeout = settings.HEARTBEAT_TIMEOUT_SECONDS
        cutoff = now - timedelta(seconds=timeout)
        stale_devices = self.device_repo.get_online_stale(cutoff, limit=batch_size or settings.RECONCILIATION_BATCH_SIZE)

        transitioned = 0
        for device in stale_devices:
            computed_status = self.calculate_status(last_seen=device.last_seen, now=now, timeout_seconds=timeout)
            if computed_status != DeviceStatus.OFFLINE or device.status == DeviceStatus.OFFLINE:
                continue

            previous_status = device.status
            device.status = DeviceStatus.OFFLINE
            self.db.add(device)
            self.db.commit()
            self.db.refresh(device)
            self.history_repo.create(
                device_id=device.id,
                previous_status=previous_status,
                new_status=DeviceStatus.OFFLINE,
                reason="heartbeat_timeout_exceeded",
            )
            payload = device_payload(device)
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.DEVICE_OFFLINE,
                    data=payload,
                    reason="heartbeat_timeout_exceeded",
                ),
                dedupe_key=f"device_offline:{device.id}",
            )
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.DEVICE_UPDATED,
                    data=payload,
                    reason="heartbeat_timeout_exceeded",
                ),
                dedupe_key=f"device_updated:{device.id}:{device.status.value}",
            )
            _get_alert_engine(self.db).evaluate_device_offline(device)
            transitioned += 1

        return transitioned
