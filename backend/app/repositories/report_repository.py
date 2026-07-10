from datetime import datetime
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.time import utcnow
from app.models.client import Client
from app.models.report import ReportRun, ReportRunStatus, ReportSchedule


class ReportScheduleRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, schedule_id: int) -> Optional[ReportSchedule]:
        return self.db.query(ReportSchedule).filter(ReportSchedule.id == schedule_id).first()

    def list(self) -> List[Tuple[ReportSchedule, str]]:
        return (
            self.db.query(ReportSchedule, Client.name)
            .join(Client, Client.id == ReportSchedule.client_id)
            .order_by(ReportSchedule.name.asc())
            .all()
        )

    def list_due(self, now: datetime, limit: int = 20) -> List[ReportSchedule]:
        return (
            self.db.query(ReportSchedule)
            .filter(ReportSchedule.enabled.is_(True), ReportSchedule.next_run_at <= now)
            .order_by(ReportSchedule.next_run_at.asc())
            .limit(limit)
            .all()
        )

    def create(self, **values) -> ReportSchedule:
        obj = ReportSchedule(**values)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, obj: ReportSchedule, **values) -> ReportSchedule:
        for key, value in values.items():
            setattr(obj, key, value)
        obj.updated_at = utcnow()
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, obj: ReportSchedule) -> None:
        self.db.delete(obj)
        self.db.commit()


class ReportRunRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, run_id: int) -> Optional[ReportRun]:
        return self.db.query(ReportRun).filter(ReportRun.id == run_id).first()

    def list_history(
        self,
        *,
        scope: Optional[AllowedScope] = None,
        client_id: Optional[int] = None,
        status: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Tuple[List[ReportRun], int]:
        query = self.db.query(ReportRun)
        if scope is not None:
            if not scope.client_ids:
                return [], 0
            query = query.filter(ReportRun.client_id.in_(scope.client_ids))
        if client_id is not None:
            query = query.filter(ReportRun.client_id == client_id)
        if status is not None:
            query = query.filter(ReportRun.status == status)
        total = query.count()
        items = query.order_by(ReportRun.created_at.desc()).offset(offset).limit(limit).all()
        return items, total

    def create(self, **values) -> ReportRun:
        obj = ReportRun(**values)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def mark_completed(self, obj: ReportRun, *, filename: str, storage_path: str, size_bytes: int) -> ReportRun:
        obj.status = ReportRunStatus.COMPLETED.value
        obj.filename = filename
        obj.storage_path = storage_path
        obj.size_bytes = size_bytes
        obj.error_message = None
        obj.completed_at = utcnow()
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def mark_failed(self, obj: ReportRun, error_message: str) -> ReportRun:
        obj.status = ReportRunStatus.FAILED.value
        obj.error_message = error_message[:1024]
        obj.completed_at = utcnow()
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def list_expired(self, cutoff: datetime, limit: int = 500) -> List[ReportRun]:
        return (
            self.db.query(ReportRun)
            .filter(ReportRun.created_at < cutoff)
            .order_by(ReportRun.created_at.asc())
            .limit(limit)
            .all()
        )

    def delete_many(self, rows: List[ReportRun]) -> None:
        for row in rows:
            self.db.delete(row)
        self.db.commit()

    def delete(self, row: ReportRun) -> None:
        self.db.delete(row)
        self.db.commit()
