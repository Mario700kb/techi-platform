from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert


class AlertRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_open_by_device_and_kind(self, device_id: int, kind: AlertKind) -> Optional[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind,
                DeviceAlert.state == AlertState.OPEN,
            )
            .first()
        )

    def get_most_recent_resolved(self, device_id: int, kind: AlertKind) -> Optional[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind,
                DeviceAlert.state == AlertState.RESOLVED,
            )
            .order_by(DeviceAlert.resolved_at.desc())
            .first()
        )

    def create(
        self,
        *,
        device_id: int,
        kind: AlertKind,
        severity: AlertSeverity,
        message: str,
        detail: Optional[str] = None,
        cooldown_seconds: int = 300,
    ) -> DeviceAlert:
        now = utcnow()
        db_obj = DeviceAlert(
            device_id=device_id,
            kind=kind,
            severity=severity,
            state=AlertState.OPEN,
            message=message,
            detail=detail,
            created_at=now,
            updated_at=now,
        )
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def resolve(self, alert_id: int, cooldown_seconds: int = 300) -> Optional[DeviceAlert]:
        alert = self.db.query(DeviceAlert).filter(DeviceAlert.id == alert_id).first()
        if not alert:
            return None
        now = utcnow()
        alert.state = AlertState.RESOLVED
        alert.resolved_at = now
        alert.updated_at = now
        if cooldown_seconds > 0:
            alert.cooldown_until = now + timedelta(seconds=cooldown_seconds)
        self.db.add(alert)
        self.db.commit()
        self.db.refresh(alert)
        return alert

    def get_by_device(
        self,
        device_id: int,
        state: Optional[AlertState] = None,
        limit: int = 20,
    ) -> List[DeviceAlert]:
        q = self.db.query(DeviceAlert).filter(DeviceAlert.device_id == device_id)
        if state is not None:
            q = q.filter(DeviceAlert.state == state)
        return q.order_by(DeviceAlert.created_at.desc()).limit(limit).all()

    def get_recent_open(self, limit: int = 50) -> List[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(DeviceAlert.state == AlertState.OPEN)
            .order_by(DeviceAlert.created_at.desc())
            .limit(limit)
            .all()
        )

    def get_recent_all(self, limit: int = 50, offset: int = 0) -> List[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .order_by(DeviceAlert.created_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

    def count_open(self) -> int:
        return self.db.query(DeviceAlert).filter(DeviceAlert.state == AlertState.OPEN).count()

    def count_open_by_severity(self) -> Dict[str, int]:
        rows = (
            self.db.query(DeviceAlert.severity, func.count(DeviceAlert.id))
            .filter(DeviceAlert.state == AlertState.OPEN)
            .group_by(DeviceAlert.severity)
            .all()
        )
        return {row[0].value: row[1] for row in rows}

    def count_open_by_device_and_severity(self, device_ids: List[int]) -> Dict[int, Dict[str, int]]:
        if not device_ids:
            return {}
        rows = (
            self.db.query(DeviceAlert.device_id, DeviceAlert.severity, func.count(DeviceAlert.id))
            .filter(DeviceAlert.state == AlertState.OPEN)
            .filter(DeviceAlert.device_id.in_(device_ids))
            .group_by(DeviceAlert.device_id, DeviceAlert.severity)
            .all()
        )
        counts: Dict[int, Dict[str, int]] = {}
        for device_id, severity, count in rows:
            counts.setdefault(device_id, {})[severity.value] = count
        return counts
