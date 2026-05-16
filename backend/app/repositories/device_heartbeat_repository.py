from typing import List, Optional
from sqlalchemy.orm import Session

from app.models.device_heartbeat import DeviceHeartbeat
from app.schemas.agent import DeviceHeartbeatCreate


class DeviceHeartbeatRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, obj_in: DeviceHeartbeatCreate) -> DeviceHeartbeat:
        db_obj = DeviceHeartbeat(**obj_in.model_dump())
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def get(self, heartbeat_id: int) -> Optional[DeviceHeartbeat]:
        return self.db.query(DeviceHeartbeat).filter(DeviceHeartbeat.id == heartbeat_id).first()

    def get_recent_by_device(self, device_id: int, limit: int = 30) -> List[DeviceHeartbeat]:
        return (
            self.db.query(DeviceHeartbeat)
            .filter(DeviceHeartbeat.device_id == device_id)
            .order_by(DeviceHeartbeat.created_at.desc())
            .limit(limit)
            .all()
        )
