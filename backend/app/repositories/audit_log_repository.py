import json
from datetime import datetime
from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.audit_log import AuditLog


class AuditLogRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        *,
        operator_id: Optional[int],
        operator_username: Optional[str],
        action: str,
        entity_type: Optional[str] = None,
        entity_id: Optional[int] = None,
        details: Optional[dict] = None,
    ) -> AuditLog:
        entry = AuditLog(
            operator_id=operator_id,
            operator_username=operator_username,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details_json=json.dumps(details) if details else None,
            created_at=utcnow(),
        )
        self.db.add(entry)
        self.db.commit()
        return entry

    def get_multi(
        self,
        *,
        operator_username: Optional[str] = None,
        action: Optional[str] = None,
        entity_type: Optional[str] = None,
        from_dt: Optional[datetime] = None,
        to_dt: Optional[datetime] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[AuditLog]:
        q = self.db.query(AuditLog)
        if operator_username:
            q = q.filter(AuditLog.operator_username == operator_username)
        if action:
            q = q.filter(AuditLog.action == action)
        if entity_type:
            q = q.filter(AuditLog.entity_type == entity_type)
        if from_dt:
            q = q.filter(AuditLog.created_at >= from_dt)
        if to_dt:
            q = q.filter(AuditLog.created_at <= to_dt)
        return q.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit).all()

    def count(
        self,
        *,
        operator_username: Optional[str] = None,
        action: Optional[str] = None,
        entity_type: Optional[str] = None,
        from_dt: Optional[datetime] = None,
        to_dt: Optional[datetime] = None,
    ) -> int:
        q = self.db.query(AuditLog)
        if operator_username:
            q = q.filter(AuditLog.operator_username == operator_username)
        if action:
            q = q.filter(AuditLog.action == action)
        if entity_type:
            q = q.filter(AuditLog.entity_type == entity_type)
        if from_dt:
            q = q.filter(AuditLog.created_at >= from_dt)
        if to_dt:
            q = q.filter(AuditLog.created_at <= to_dt)
        return q.count()

    def facets(self) -> dict:
        """Every action, entity type and operator present, with how often, so
        the filters offer what the log really holds instead of a fixed list."""
        def grouped(column):
            rows = (
                self.db.query(column, func.count(AuditLog.id))
                .filter(column.isnot(None))
                .group_by(column)
                .order_by(func.count(AuditLog.id).desc(), column)
                .all()
            )
            return [{"value": value, "count": count} for value, count in rows]

        return {
            "actions": grouped(AuditLog.action),
            "entity_types": grouped(AuditLog.entity_type),
            "operators": grouped(AuditLog.operator_username),
        }
