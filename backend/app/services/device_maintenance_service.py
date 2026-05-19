import logging
from datetime import datetime, timedelta
from app.core.time import utcnow
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import DeviceUpdate

logger = logging.getLogger(__name__)


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
            return self.repo.update(
                device,
                DeviceUpdate(
                    is_in_maintenance=False,
                    maintenance_started_at=None,
                    maintenance_ends_at=None,
                    maintenance_note=None,
                    maintenance_started_by=None,
                ),
            )
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
        return self.repo.update(
            device,
            DeviceUpdate(
                is_in_maintenance=False,
                maintenance_started_at=None,
                maintenance_ends_at=None,
                maintenance_note=None,
                maintenance_started_by=None,
            ),
        )
