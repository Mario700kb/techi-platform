import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.repositories.device_activity_event_repository import DeviceActivityEventRepository

logger = logging.getLogger(__name__)


class DeviceActivityEventService:
    def __init__(self, db: Session):
        self.db = db
        self.repository = DeviceActivityEventRepository(db)

    def record(
        self,
        *,
        device_id: int,
        event_type: str,
        summary: str,
        detail: Optional[str] = None,
        actor: Optional[str] = None,
        occurred_at: Optional[datetime] = None,
        fail_silently: bool = False,
    ):
        try:
            return self.repository.create(
                device_id=device_id,
                event_type=event_type,
                summary=summary,
                detail=detail,
                actor=actor,
                occurred_at=occurred_at,
            )
        except Exception:
            self.db.rollback()
            logger.exception("Failed to record device activity event")
            if not fail_silently:
                raise
            return None

