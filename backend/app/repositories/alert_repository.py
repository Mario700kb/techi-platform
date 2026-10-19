from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.core.time import utcnow, utcnow_naive
from app.models.alert import AlertActivity, AlertKind, AlertMute, AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device

if TYPE_CHECKING:
    from app.core.scope import AllowedScope

AlertRow = Tuple[DeviceAlert, Optional[str], Optional[str], Optional[str]]


class AlertRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_open_by_device_and_kind(self, device_id: int, kind: AlertKind) -> Optional[DeviceAlert]:
        """Any open alert of the kind (whatever its fingerprint)."""
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind.value,
                DeviceAlert.state == AlertState.OPEN.value,
            )
            .first()
        )

    def get_open(self, device_id: int, kind: AlertKind, fingerprint: str = "") -> Optional[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind.value,
                DeviceAlert.state == AlertState.OPEN.value,
                DeviceAlert.fingerprint == (fingerprint or ""),
            )
            .first()
        )

    def list_open_for_device_kind(self, device_id: int, kind: AlertKind) -> List[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind.value,
                DeviceAlert.state == AlertState.OPEN.value,
            )
            .all()
        )

    def get_most_recent_resolved(self, device_id: int, kind: AlertKind, fingerprint: str = "") -> Optional[DeviceAlert]:
        return (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id,
                DeviceAlert.kind == kind.value,
                DeviceAlert.state == AlertState.RESOLVED.value,
                DeviceAlert.fingerprint == (fingerprint or ""),
            )
            .order_by(DeviceAlert.resolved_at.desc())
            .first()
        )

    def add_activity(self, alert_id: int, action: str, actor: Optional[str] = None, detail: Optional[str] = None) -> AlertActivity:
        """Adds a timeline row; the caller commits."""
        row = AlertActivity(alert_id=alert_id, at=utcnow_naive(), actor=actor, action=action,
                            detail=(detail or None) and detail[:1000])
        self.db.add(row)
        return row

    def active_mutes(self) -> List[AlertMute]:
        now = utcnow_naive()
        return (
            self.db.query(AlertMute)
            .filter(AlertMute.removed_at.is_(None))
            .filter(or_(AlertMute.until.is_(None), AlertMute.until > now))
            .all()
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
        fingerprint: str = "",
        priority: Optional[int] = None,
    ) -> DeviceAlert:
        now = utcnow()
        db_obj = DeviceAlert(
            device_id=device_id,
            kind=kind.value,
            severity=AlertSeverity(getattr(severity, "value", severity)).value,
            state=AlertState.OPEN.value,
            message=message[:512],
            detail=detail[:1024] if detail else detail,
            created_at=now,
            updated_at=now,
            last_seen_at=now,
            fingerprint=fingerprint or "",
            occurrences=1,
            priority=priority,
        )
        self.db.add(db_obj)
        self.db.flush()
        self.add_activity(db_obj.id, "opened", None, message[:300])
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def reopen(self, alert: DeviceAlert, *, severity: AlertSeverity, message: str, detail: Optional[str], priority: Optional[int]) -> DeviceAlert:
        """The same problem again within a day: the row opens again, counted."""
        now = utcnow()
        alert.state = AlertState.OPEN.value
        alert.severity = AlertSeverity(getattr(severity, "value", severity)).value
        alert.message = message[:512]
        alert.detail = detail[:1024] if detail else detail
        alert.occurrences = (alert.occurrences or 1) + 1
        alert.priority = priority
        alert.resolved_at = None
        alert.resolution = None
        alert.resolved_by = None
        alert.cooldown_until = None
        alert.snoozed_until = None
        alert.snooze_until_worse = False
        alert.escalated_at = None
        alert.updated_at = now
        alert.last_seen_at = now
        self.add_activity(alert.id, "reopened", None, f"Back again (×{alert.occurrences}): {message[:250]}")
        self.db.commit()
        self.db.refresh(alert)
        return alert

    def resolve(
        self,
        alert_id: int,
        cooldown_seconds: int = 300,
        resolution: str = "auto",
        resolved_by: Optional[str] = None,
        note: Optional[str] = None,
    ) -> Optional[DeviceAlert]:
        alert = self.db.query(DeviceAlert).filter(DeviceAlert.id == alert_id).first()
        if not alert:
            return None
        now = utcnow()
        alert.state = AlertState.RESOLVED.value
        alert.resolved_at = now
        alert.updated_at = now
        alert.resolution = resolution
        alert.resolved_by = resolved_by
        alert.snoozed_until = None
        alert.snooze_until_worse = False
        alert.cooldown_until = now + timedelta(seconds=cooldown_seconds) if cooldown_seconds > 0 else None
        self.db.add(alert)
        self.add_activity(alert.id, "resolved", resolved_by, f"{resolution}: {note}" if note else resolution)
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
        elif state == AlertState.RESOLVED.value:
            # Newest resolution first: what was just fixed leads the list.
            return (
                query.filter(DeviceAlert.state == AlertState.RESOLVED.value)
                .order_by(DeviceAlert.resolved_at.desc(), DeviceAlert.id.desc())
                .offset(offset)
                .limit(limit)
                .all()
            )
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


# ── the work queue ─────────────────────────────────────────────────────────

QUEUE_VIEWS = ("needs_action", "mine", "open", "snoozed", "resolved")
QueueRow = Tuple[DeviceAlert, Optional[str], Optional[str], Optional[str], Optional[int], Optional[str]]


def issue_key(kind, fingerprint: Optional[str]) -> str:
    """Alerts that are the same problem on different devices: the kind, plus
    the event group or the protection that was switched off."""
    kind = getattr(kind, "value", kind)
    fingerprint = fingerprint or ""
    if fingerprint.startswith(("evt:", "regress:")):
        return f"{kind}|{fingerprint}"
    return kind


class AlertQueueRepository(AlertRepository):
    """The Alerts page: views, filters, groups and counts over the operator's scope."""

    def _base(self, scope):
        from app.models.device_group import DeviceGroup
        from app.platform_core import classification as clf

        query = self.db.query(
            DeviceAlert, Device.hostname, Device.display_name, Client.name, Device.client_id, clf.category_case()
        )
        query = self._in_scope(query, scope)
        query = query.outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)
        return query.outerjoin(Client, Client.id == Device.client_id)

    @staticmethod
    def _filter(query, *, view: str, operator_id: Optional[int], severity=None, priority=None, kind=None,
                issue=None, client_id=None, device_id=None, search=None):
        now = utcnow_naive()
        snoozed = and_(DeviceAlert.snoozed_until.isnot(None), DeviceAlert.snoozed_until > now)
        if view == "resolved":
            query = query.filter(DeviceAlert.state == AlertState.RESOLVED.value)
        else:
            query = query.filter(DeviceAlert.state == AlertState.OPEN.value)
            if view == "snoozed":
                query = query.filter(snoozed)
            elif view != "all_open":
                query = query.filter(~snoozed)
            if view == "needs_action":
                query = query.filter(func.coalesce(DeviceAlert.priority, 3) <= 2)
                query = query.filter(or_(DeviceAlert.assigned_to_id.is_(None), DeviceAlert.assigned_to_id == operator_id))
            elif view == "mine":
                query = query.filter(DeviceAlert.assigned_to_id == operator_id)
        if severity:
            query = query.filter(DeviceAlert.severity == severity)
        if priority:
            query = query.filter(DeviceAlert.priority == int(priority))
        if kind:
            query = query.filter(DeviceAlert.kind == kind)
        if issue:
            issue_kind, _, fingerprint = issue.partition("|")
            query = query.filter(DeviceAlert.kind == issue_kind)
            if fingerprint:
                query = query.filter(DeviceAlert.fingerprint == fingerprint)
        if client_id is not None:
            query = query.filter(Device.client_id == client_id)
        if device_id is not None:
            query = query.filter(DeviceAlert.device_id == device_id)
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

    def queue(self, scope, *, view: str = "open", operator_id: Optional[int] = None, limit: int = 50, offset: int = 0,
              **filters) -> Tuple[List[QueueRow], int]:
        query = self._filter(self._base(scope), view=view, operator_id=operator_id, **filters)
        total = query.with_entities(func.count(DeviceAlert.id)).order_by(None).scalar() or 0
        if view == "resolved":
            order = (DeviceAlert.resolved_at.desc(), DeviceAlert.id.desc())
        else:
            order = (
                func.coalesce(DeviceAlert.priority, 3).asc(),
                func.coalesce(DeviceAlert.last_seen_at, DeviceAlert.created_at).desc(),
                DeviceAlert.id.desc(),
            )
        rows = query.order_by(*order).offset(offset).limit(limit).all()
        return rows, total

    def groups(self, scope, *, by: str, view: str = "open", operator_id: Optional[int] = None, **filters) -> List[dict]:
        """Open alerts grouped by issue, client or device, most urgent first."""
        rows = self._filter(self._base(scope), view=view, operator_id=operator_id, **filters).limit(5000).all()
        groups: Dict[str, dict] = {}
        for alert, hostname, display_name, client_name, client_id, _category in rows:
            if by == "client":
                key, label = f"client:{client_id or 0}", client_name or "No client"
            elif by == "device":
                key, label = f"device:{alert.device_id}", (display_name or "").strip() or hostname or f"Device #{alert.device_id}"
            else:
                key, label = issue_key(alert.kind, alert.fingerprint), None
            group = groups.setdefault(key, {
                "key": key, "label": label, "count": 0, "devices": set(), "priority": 4,
                "critical": 0, "latest": None, "kind": getattr(alert.kind, "value", alert.kind),
                "fingerprint": alert.fingerprint if key.count("|") else "",
                "client_id": client_id if by == "client" else None,
                "device_id": alert.device_id if by == "device" else None,
            })
            group["count"] += 1
            group["devices"].add(alert.device_id)
            group["priority"] = min(group["priority"], alert.priority or 3)
            if getattr(alert.severity, "value", alert.severity) == "critical":
                group["critical"] += 1
            seen = alert.last_seen_at or alert.created_at
            if group["latest"] is None or seen > group["latest"]:
                group["latest"] = seen
        out = []
        for group in groups.values():
            group["devices"] = len(group["devices"])
            out.append(group)
        return sorted(out, key=lambda g: (g["priority"], -g["count"]))

    def view_counts(self, scope, *, operator_id: Optional[int], search: Optional[str] = None) -> dict:
        now = utcnow_naive()
        query = self._filter(self._base(scope), view="all_open", operator_id=operator_id, search=search)
        query = query.filter(DeviceAlert.state == AlertState.OPEN.value)
        rows = query.with_entities(
            DeviceAlert.priority, DeviceAlert.assigned_to_id, DeviceAlert.snoozed_until, DeviceAlert.severity, DeviceAlert.kind
        ).limit(20000).all()
        counts = {"needs_action": 0, "mine": 0, "open": 0, "snoozed": 0}
        by_priority: Dict[str, int] = {}
        for priority, assigned, snoozed_until, _severity, _kind in rows:
            if snoozed_until is not None and snoozed_until > now:
                counts["snoozed"] += 1
                continue
            counts["open"] += 1
            p = priority or 3
            by_priority[str(p)] = by_priority.get(str(p), 0) + 1
            if assigned is not None and assigned == operator_id:
                counts["mine"] += 1
            if p <= 2 and (assigned is None or assigned == operator_id):
                counts["needs_action"] += 1
        return {"views": counts, "by_priority": by_priority}

    def activity(self, alert_id: int) -> List[AlertActivity]:
        return (
            self.db.query(AlertActivity)
            .filter(AlertActivity.alert_id == alert_id)
            .order_by(AlertActivity.at.desc(), AlertActivity.id.desc())
            .limit(200)
            .all()
        )

    def history(self, alert: DeviceAlert, days: int = 30) -> List[datetime]:
        """When this problem opened on this device (first opening and every
        reopening), within ``days``."""
        since = utcnow_naive() - timedelta(days=days)
        ids = [
            row[0]
            for row in self.db.query(DeviceAlert.id)
            .filter(
                DeviceAlert.device_id == alert.device_id,
                DeviceAlert.kind == getattr(alert.kind, "value", alert.kind),
                DeviceAlert.fingerprint == (alert.fingerprint or ""),
                func.coalesce(DeviceAlert.last_seen_at, DeviceAlert.created_at) >= since,
            )
            .all()
        ]
        if not ids:
            return []
        return [
            row[0]
            for row in self.db.query(AlertActivity.at)
            .filter(AlertActivity.alert_id.in_(ids), AlertActivity.action.in_(("opened", "reopened")), AlertActivity.at >= since)
            .order_by(AlertActivity.at)
            .all()
        ]
