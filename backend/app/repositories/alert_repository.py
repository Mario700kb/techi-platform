from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device

if TYPE_CHECKING:
    from app.core.scope import AllowedScope

AlertRow = Tuple[DeviceAlert, Optional[str], Optional[str], Optional[str]]


class AlertRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_open_by_device_and_kind(self, device_id: int, kind: AlertKind) -> Optional[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind.value,
                DeviceAlert.state == AlertState.OPEN.value,
            )
            .first()
        )

    def get_most_recent_resolved(self, device_id: int, kind: AlertKind) -> Optional[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind.value,
                DeviceAlert.state == AlertState.RESOLVED.value,
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
            kind=kind.value,
            severity=severity.value,
            state=AlertState.OPEN.value,
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
        alert.state = AlertState.RESOLVED.value
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
        state: Optional[str] = None,
        limit: int = 20,
    ) -> List[DeviceAlert]:
        q = self.db.query(DeviceAlert).filter(DeviceAlert.device_id == device_id)
        if state is not None:
            q = q.filter(DeviceAlert.state == state)
        if state == "resolved":
            # "Recently resolved" means resolved recently: an alert opened days
            # ago but resolved an hour ago belongs at the top.
            order = (DeviceAlert.resolved_at.desc().nulls_last(), DeviceAlert.id.desc())
        else:
            order = (DeviceAlert.created_at.desc(), DeviceAlert.id.desc())
        return q.order_by(*order).limit(limit).all()

    def _in_scope(self, query, scope: Optional["AllowedScope"]):
        # Alerts belong to devices: an operator sees, counts and resolves only
        # the alerts of devices inside their scope.
        from app.repositories.device_repository import DeviceRepository

        query = query.join(Device, Device.id == DeviceAlert.device_id)
        return DeviceRepository(self.db)._apply_scope_filter(query, scope)

    def list_with_device(
        self,
        scope: Optional["AllowedScope"] = None,
        state: Optional[str] = None,
        severity: Optional[str] = None,
        kind: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[AlertRow]:
        query = self._with_client(
            self._in_scope(self.db.query(DeviceAlert, Device.hostname, Device.display_name, Client.name), scope),
            search,
        )
        if state == AlertState.OPEN.value:
            query = query.filter(DeviceAlert.state == AlertState.OPEN.value)
        if severity:
            query = query.filter(DeviceAlert.severity == severity)
        if kind:
            query = query.filter(DeviceAlert.kind == kind)
        return query.order_by(DeviceAlert.created_at.desc(), DeviceAlert.id.desc()).offset(offset).limit(limit).all()

    @staticmethod
    def _with_client(query, search: Optional[str]):
        query = query.outerjoin(Client, Client.id == Device.client_id)
        term = (search or "").strip()
        if term:
            pattern = f"%{term}%"
            query = query.filter(or_(
                Device.hostname.ilike(pattern),
                Device.display_name.ilike(pattern),
                Client.name.ilike(pattern),
                DeviceAlert.message.ilike(pattern),
            ))
        return query

    def open_counts(self, scope: Optional["AllowedScope"] = None, search: Optional[str] = None) -> dict:
        """Open alerts by severity and kind, the devices they touch and the
        oldest one, over the same scope and search as the list."""
        base = self._with_client(self._in_scope(self.db.query(DeviceAlert), scope), search).filter(
            DeviceAlert.state == AlertState.OPEN.value
        )
        rows = (
            base.with_entities(DeviceAlert.severity, DeviceAlert.kind, func.count(DeviceAlert.id))
            .group_by(DeviceAlert.severity, DeviceAlert.kind)
            .all()
        )
        by_severity: Dict[str, int] = {}
        by_kind: Dict[str, int] = {}
        total = 0
        for severity, kind, count in rows:
            severity_value = getattr(severity, "value", severity)
            kind_value = getattr(kind, "value", kind)
            by_severity[severity_value] = by_severity.get(severity_value, 0) + count
            by_kind[kind_value] = by_kind.get(kind_value, 0) + count
            total += count
        devices, oldest = base.with_entities(
            func.count(func.distinct(DeviceAlert.device_id)), func.min(DeviceAlert.created_at)
        ).one()
        return {
            "total": total,
            "by_severity": by_severity,
            "by_kind": by_kind,
            "devices_affected": devices or 0,
            "oldest_open_at": oldest,
        }

    def list_open_for_device(self, device_id: int) -> List[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(DeviceAlert.device_id == device_id, DeviceAlert.state == AlertState.OPEN.value)
            .all()
        )

    def get_in_scope(self, alert_id: int, scope: Optional["AllowedScope"] = None) -> Optional[DeviceAlert]:
        return self._in_scope(self.db.query(DeviceAlert), scope).filter(DeviceAlert.id == alert_id).first()

    def count_open_by_device_and_severity(self, device_ids: List[int]) -> Dict[int, Dict[str, int]]:
        if not device_ids:
            return {}
        rows = (
            self.db.query(DeviceAlert.device_id, DeviceAlert.severity, func.count(DeviceAlert.id))
            .filter(DeviceAlert.state == AlertState.OPEN.value)
            .filter(DeviceAlert.device_id.in_(device_ids))
            .group_by(DeviceAlert.device_id, DeviceAlert.severity)
            .all()
        )
        counts: Dict[int, Dict[str, int]] = {}
        for device_id, severity, count in rows:
            counts.setdefault(device_id, {})[severity.value] = count
        return counts

    def get_client_activity(self, client_id: int, start: datetime, end: datetime, limit: int = 5000) -> List[DeviceAlert]:
        """Alert rows for Reporting v1, scoped through the owning device."""
        return (
            self.db.query(DeviceAlert)
            .join(Device, Device.id == DeviceAlert.device_id)
            .filter(
                Device.client_id == client_id,
                DeviceAlert.created_at >= start,
                DeviceAlert.created_at <= end,
            )
            .order_by(DeviceAlert.created_at.desc())
            .limit(limit)
            .all()
        )

    def count_client_activity(self, client_id: int, start: datetime, end: datetime) -> Dict[str, int]:
        rows = (
            self.db.query(DeviceAlert.severity, func.count(DeviceAlert.id))
            .join(Device, Device.id == DeviceAlert.device_id)
            .filter(
                Device.client_id == client_id,
                DeviceAlert.created_at >= start,
                DeviceAlert.created_at <= end,
            )
            .group_by(DeviceAlert.severity)
            .all()
        )
        result = {_value.value if hasattr(_value, "value") else str(_value): count for _value, count in rows}
        result["total"] = sum(result.values())
        return result
