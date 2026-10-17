import json
from datetime import datetime
from typing import List, Optional, Tuple

from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.audit_log import AuditLog
from app.models.device import Device


def _as_int(value) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None



# Entries that end a session; its start entry carries the length instead.
SESSION_END_ACTIONS = ("remote_session_ended", "terminal_session_closed", "ssh_session_ended")

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
        device_id, client_id = self._subject(entity_type, entity_id, details)
        entry = AuditLog(
            operator_id=operator_id,
            operator_username=operator_username,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details_json=json.dumps(details) if details else None,
            device_id=device_id,
            client_id=client_id,
            created_at=utcnow(),
        )
        self.db.add(entry)
        self.db.commit()
        return entry

    def _subject(
        self, entity_type: Optional[str], entity_id: Optional[int], details: Optional[dict]
    ) -> Tuple[Optional[int], Optional[int]]:
        details = details or {}
        device_id = entity_id if entity_type == "device" else _as_int(details.get("device_id"))
        client_id = entity_id if entity_type == "client" else _as_int(details.get("client_id"))
        if client_id is None and device_id is not None:
            client_id = self.db.query(Device.client_id).filter(Device.id == device_id).scalar()
        return device_id, client_id

    def _client_query(self, client_id: int, device_ids: Optional[List[int]]):
        q = self.db.query(AuditLog)
        if device_ids is None:
            return q.filter(AuditLog.client_id == client_id)
        return q.filter(AuditLog.device_id.in_(device_ids or [-1]))

    def for_client(
        self,
        client_id: int,
        device_ids: Optional[List[int]],
        limit: int,
        offset: int,
        *,
        actions: Optional[List[str]] = None,
        operator_username: Optional[str] = None,
        one_row_per_session: bool = False,
    ) -> Tuple[int, List[AuditLog]]:
        """Entries about a client or its devices, newest first.

        device_ids None: the whole client. A list: an operator who sees only
        those devices of it gets only their entries.

        one_row_per_session: a session is read from the entry that started it
        (the Connect click, or a terminal/SSH open), which carries its length;
        the entries that end sessions, and a Remote Support start that a
        Connect click already stands for, are left out. A start nobody clicked
        Connect for stays — that is worth seeing.
        """
        q = self._client_query(client_id, device_ids)
        if one_row_per_session:
            q = q.filter(~AuditLog.action.in_(SESSION_END_ACTIONS)).filter(
                ~and_(
                    AuditLog.action == "remote_session_started",
                    func.coalesce(AuditLog.details_json, "").like('%"attribution": "connect_request"%'),
                )
            )
        if actions:
            q = q.filter(AuditLog.action.in_(actions))
        if operator_username:
            q = q.filter(AuditLog.operator_username == operator_username)
        total = q.count()
        rows = q.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).offset(offset).limit(limit).all()
        return total, rows

    def client_summary(
        self,
        client_id: int,
        device_ids: Optional[List[int]],
        since: datetime,
        *,
        remote_action: str,
        duration_actions: List[str],
        top: int = 6,
    ) -> dict:
        """Counts and session time for a client's entries since `since`.

        Session time comes from the entries that carry it: terminal and SSH
        sessions (duration_seconds, written once per session id but sometimes
        twice when both sides report the close) and Remote Support sessions
        ended by agents that report them (duration_minutes).
        """
        since_naive = since.replace(tzinfo=None)
        base = self._client_query(client_id, device_ids).filter(AuditLog.created_at >= since_naive)
        remote = base.filter(AuditLog.action == remote_action)

        events = base.count()
        remote_connects = remote.count()
        remote_devices = remote.with_entities(func.count(func.distinct(AuditLog.device_id))).scalar() or 0
        last_remote_at = remote.with_entities(func.max(AuditLog.created_at)).scalar()

        operators = (
            base.with_entities(
                AuditLog.operator_username,
                func.count(AuditLog.id),
                func.sum(case((AuditLog.action == remote_action, 1), else_=0)),
                func.max(AuditLog.created_at),
            )
            .filter(AuditLog.operator_username.isnot(None), AuditLog.operator_username != "unknown")
            .group_by(AuditLog.operator_username)
            .order_by(func.count(AuditLog.id).desc())
            .limit(top)
            .all()
        )
        devices = (
            remote.with_entities(AuditLog.device_id, func.count(AuditLog.id), func.max(AuditLog.created_at))
            .filter(AuditLog.device_id.isnot(None))
            .group_by(AuditLog.device_id)
            .order_by(func.count(AuditLog.id).desc(), func.max(AuditLog.created_at).desc())
            .limit(top)
            .all()
        )

        terminal_seconds: dict = {}
        remote_sessions = 0
        remote_minutes = 0
        for action, details_json in base.filter(AuditLog.action.in_(duration_actions)).with_entities(
            AuditLog.action, AuditLog.details_json
        ):
            try:
                details = json.loads(details_json or "{}") or {}
            except (TypeError, ValueError):
                continue
            if action == "remote_session_ended":
                minutes = _as_int(details.get("duration_minutes"))
                if minutes is not None:
                    remote_sessions += 1
                    remote_minutes += max(minutes, 0)
                continue
            seconds = _as_int(details.get("duration_seconds"))
            if seconds is None:
                continue
            key = (action, details.get("session_id") or id(details))
            terminal_seconds[key] = max(terminal_seconds.get(key, 0), max(seconds, 0))

        return {
            "events": events,
            "remote_connects": remote_connects,
            "remote_devices": remote_devices,
            "last_remote_at": last_remote_at,
            "terminal_sessions": len(terminal_seconds),
            "terminal_seconds": sum(terminal_seconds.values()),
            "remote_sessions": remote_sessions,
            "remote_minutes": remote_minutes,
            "operators": [
                {"username": name, "events": count, "remote_connects": int(connects or 0), "last_at": last}
                for name, count, connects, last in operators
            ],
            "devices": [
                {"device_id": device_id, "remote_connects": count, "last_at": last}
                for device_id, count, last in devices
            ],
        }

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
