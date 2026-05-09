from typing import List, Optional
from sqlalchemy.orm import Session

from app.models.device import Device, DeviceStatus, DeviceType
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import DeviceCreate, DeviceUpdate


class DeviceService:
    def __init__(self, db: Session):
        self.repository = DeviceRepository(db)

    def get_device(self, device_id: int) -> Optional[Device]:
        return self.repository.get(device_id)

    def get_device_by_rustdesk_id(self, rustdesk_id: str) -> Optional[Device]:
        return self.repository.get_by_rustdesk_id(rustdesk_id)

    def get_devices(
        self,
        skip: int = 0,
        limit: int = 100,
        status: Optional[DeviceStatus] = None,
        device_type: Optional[DeviceType] = None,
        client_id: Optional[int] = None,
        group_id: Optional[int] = None,
        search: Optional[str] = None,
    ) -> List[Device]:
        return self.repository.get_multi(
            skip=skip,
            limit=limit,
            status=status,
            device_type=device_type,
            client_id=client_id,
            group_id=group_id,
            search=search,
        )

    def create_device(self, device_in: DeviceCreate) -> Device:
        # Check if rustdesk_id already exists
        existing = self.repository.get_by_rustdesk_id(device_in.rustdesk_id)
        if existing:
            raise ValueError(f"Device with rustdesk_id {device_in.rustdesk_id} already exists")

        return self.repository.create(device_in)

    def update_device(self, device_id: int, device_in: DeviceUpdate) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        return self.repository.update(device, device_in)

    def delete_device(self, device_id: int) -> Optional[Device]:
        return self.repository.remove(device_id)

    def get_devices_count(
        self,
        status: Optional[DeviceStatus] = None,
        device_type: Optional[DeviceType] = None,
        client_id: Optional[int] = None,
        group_id: Optional[int] = None,
        search: Optional[str] = None,
    ) -> int:
        return self.repository.count(
            status=status,
            device_type=device_type,
            client_id=client_id,
            group_id=group_id,
            search=search,
        )
