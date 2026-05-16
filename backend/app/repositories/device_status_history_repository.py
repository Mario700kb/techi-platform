from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.device import DeviceStatus
from app.models.device_status_history import DeviceStatusHistory


class DeviceStatusHistoryRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(
        self,
        *,
        device_id: int,
        previous_status: Optional[DeviceStatus],
        new_status: DeviceStatus,
        reason: str,
    ) -> DeviceStatusHistory:
        db_obj = DeviceStatusHistory(
            device_id=device_id,
            previous_status=previous_status,
            new_status=new_status,
            reason=reason,
        )
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def get_recent_by_device(self, device_id: int, limit: int = 30) -> List[DeviceStatusHistory]:
        return (
            self.db.query(DeviceStatusHistory)
            .filter(DeviceStatusHistory.device_id == device_id)
            .order_by(DeviceStatusHistory.created_at.desc())
            .limit(limit)
            .all()
        )

    def count_recent_online_transitions(self, device_id: int, since: datetime) -> int:
        return (
            self.db.query(DeviceStatusHistory)
            .filter(
                DeviceStatusHistory.device_id == device_id,
                DeviceStatusHistory.new_status == DeviceStatus.ONLINE,
                DeviceStatusHistory.created_at >= since,
            )
            .count()
        )
