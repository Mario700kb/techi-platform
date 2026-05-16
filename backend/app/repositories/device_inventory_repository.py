from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.device_inventory import DeviceInventory


class DeviceInventoryRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_by_device(self, device_id: int) -> Optional[DeviceInventory]:
        return (
            self.db.query(DeviceInventory)
            .filter(DeviceInventory.device_id == device_id)
            .first()
        )

    def get_many_by_device_ids(self, device_ids: List[int]) -> List[DeviceInventory]:
        if not device_ids:
            return []
        return (
            self.db.query(DeviceInventory)
            .filter(DeviceInventory.device_id.in_(device_ids))
            .all()
        )

    def upsert(
        self,
        device_id: int,
        processes_json: Optional[str],
        services_json: Optional[str],
        software_json: Optional[str],
        patch_json: Optional[str],
        collected_at: datetime,
    ) -> DeviceInventory:
        obj = self.get_by_device(device_id)
        if obj is not None:
            if processes_json is not None:
                obj.processes_json = processes_json
            if services_json is not None:
                obj.services_json = services_json
            if software_json is not None:
                obj.software_json = software_json
            if patch_json is not None:
                obj.patch_json = patch_json
            obj.collected_at = collected_at
        else:
            obj = DeviceInventory(
                device_id=device_id,
                processes_json=processes_json,
                services_json=services_json,
                software_json=software_json,
                patch_json=patch_json,
                collected_at=collected_at,
            )
            self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj
