from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.device_activity_event import DeviceActivityEvent


class DeviceActivityEventRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(
        self,
        *,
        device_id: int,
        event_type: str,
        summary: str,
        detail: Optional[str] = None,
        actor: Optional[str] = None,
        occurred_at: Optional[datetime] = None,
    ) -> DeviceActivityEvent:
        event = DeviceActivityEvent(
            device_id=device_id,
            event_type=event_type,
            summary=summary,
            detail=detail,
            actor=actor,
            occurred_at=occurred_at or utcnow(),
        )
        self.db.add(event)
        self.db.commit()
        self.db.refresh(event)
        return event

    def get_recent_by_device(self, device_id: int, limit: int = 40) -> List[DeviceActivityEvent]:
        return (
            self.db.query(DeviceActivityEvent)
            .filter(DeviceActivityEvent.device_id == device_id)
            .order_by(DeviceActivityEvent.occurred_at.desc())
            .limit(limit)
            .all()
        )

