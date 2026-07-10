import logging
from datetime import datetime, timedelta
from app.core.time import utcnow
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import DeviceUpdate
from app.services.notification_events import NotificationEvent
from app.services.notification_service import NotificationService

logger = logging.getLogger(__name__)


def _notify_maintenance_finished(db: Session, device: Device) -> None:
    hostname = device.hostname or f"device-{device.id}"
    NotificationService(db).dispatch(
        event_type=NotificationEvent.MAINTENANCE_FINISHED,
        title=f"Maintenance finished on {hostname}",
        message=f"Maintenance mode ended for {hostname}.",
        severity="info",
        device_id=device.id,
        client_id=getattr(device, "client_id", None),
    )


def is_maintenance_active(device) -> bool:
    """Read-only check using device attributes only — no DB access."""
    if not getattr(device, "is_in_maintenance", False):
        return False
    ends_at = getattr(device, "maintenance_ends_at", None)
    if ends_at and ends_at < utcnow():
        return False
    return True


class DeviceMaintenanceService:
    def __init__(self, db: Session):
        self.repo = DeviceRepository(db)

    def expire_if_needed(self, device: Device) -> Device:
        """Lazy expiration: clear maintenance when maintenance_ends_at has passed."""
        if not device.is_in_maintenance:
            return device
        if device.maintenance_ends_at and device.maintenance_ends_at < utcnow():
            logger.info("[maintenance] expired for device #%d, clearing", device.id)
            updated = self.repo.update(
                device,
                DeviceUpdate(
                    is_in_maintenance=False,
                    maintenance_started_at=None,
                    maintenance_ends_at=None,
                    maintenance_note=None,
                    maintenance_started_by=None,
                ),
            )
            _notify_maintenance_finished(self.repo.db, updated)
            return updated
        return device

    def enter_maintenance(
        self,
        device: Device,
        duration_minutes: Optional[int] = None,
        note: Optional[str] = None,
        started_by: Optional[str] = None,
    ) -> Device:
        now = utcnow()
        ends_at = now + timedelta(minutes=duration_minutes) if duration_minutes else None
        logger.info(
            "[maintenance] device #%d entered by=%s duration=%s",
            device.id,
            started_by,
            f"{duration_minutes}min" if duration_minutes else "indefinite",
        )
        return self.repo.update(
            device,
            DeviceUpdate(
                is_in_maintenance=True,
                maintenance_started_at=now,
                maintenance_ends_at=ends_at,
                maintenance_note=note or None,
                maintenance_started_by=started_by or None,
            ),
        )

    def clear_maintenance(self, device: Device) -> Device:
        logger.info("[maintenance] device #%d cleared", device.id)
        updated = self.repo.update(
            device,
            DeviceUpdate(
                is_in_maintenance=False,
                maintenance_started_at=None,
                maintenance_ends_at=None,
                maintenance_note=None,
                maintenance_started_by=None,
            ),
        )
        _notify_maintenance_finished(self.repo.db, updated)
        return updated
