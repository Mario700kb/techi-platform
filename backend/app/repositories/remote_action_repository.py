import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import case
from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow
from app.models.remote_action import ActionStatus, EXPIRABLE_STATUSES, RemoteAction

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 30


class RemoteActionRepository:
    def __init__(self, db: Session):
        self.db = db

    # ------------------------------------------------------------------ #
    # Read                                                                 #
    # ------------------------------------------------------------------ #

    def get(self, action_id: int) -> Optional[RemoteAction]:
        return self.db.query(RemoteAction).filter(RemoteAction.id == action_id).first()

    def get_recent_for_device(self, device_id: int, limit: int = _DEFAULT_LIMIT) -> List[RemoteAction]:
        actions = (
            self.db.query(RemoteAction)
            .filter(RemoteAction.device_id == device_id)
            .order_by(RemoteAction.created_at.desc())
            .limit(limit)
            .all()
        )
        for action in actions:
            self._expire_if_needed(action)
        return actions

    def get_filtered_for_device(
        self,
        device_id: int,
        status: Optional[str] = None,
        limit: int = _DEFAULT_LIMIT,
    ) -> List[RemoteAction]:
        q = self.db.query(RemoteAction).filter(RemoteAction.device_id == device_id)
        if status:
            try:
                q = q.filter(RemoteAction.status == ActionStatus(status))
            except ValueError:
                pass
        actions = q.order_by(RemoteAction.created_at.desc()).limit(limit).all()
        for action in actions:
            self._expire_if_needed(action)
        return actions

    def get_pending_for_device(self, device_id: int) -> List[RemoteAction]:
        actions = (
            self.db.query(RemoteAction)
            .filter(
                RemoteAction.device_id == device_id,
                RemoteAction.status == ActionStatus.QUEUED,
            )
            .order_by(
                case((RemoteAction.queued_at.is_(None), 0), else_=1),
                RemoteAction.queued_at.asc(),
                RemoteAction.created_at.asc(),
            )
            .all()
        )
        live = []
        for action in actions:
            action = self._expire_if_needed(action)
            if action.status == ActionStatus.QUEUED:
                live.append(action)
        return live

    def get_stats_for_device(self, device_id: int) -> Dict[str, int]:
        rows = (
            self.db.query(RemoteAction.status, RemoteAction.id)
            .filter(RemoteAction.device_id == device_id)
            .all()
        )
        counts: Dict[str, int] = {}
        for row in rows:
            key = row.status.value if hasattr(row.status, "value") else str(row.status)
            counts[key] = counts.get(key, 0) + 1
        return counts

    def get_recent_global(self, limit: int = 20) -> List[RemoteAction]:
        actions = (
            self.db.query(RemoteAction)
            .order_by(RemoteAction.created_at.desc())
            .limit(limit)
            .all()
        )
        for action in actions:
            self._expire_if_needed(action)
        return actions

    # ------------------------------------------------------------------ #
    # Write                                                                #
    # ------------------------------------------------------------------ #

    def create(
        self,
        device_id: int,
        action_type: str,
        parameters: Optional[dict],
        created_by: Optional[str] = None,
        execution_timeout_seconds: int = 300,
    ) -> RemoteAction:
        now = utcnow()
        action = RemoteAction(
            device_id=device_id,
            action_type=action_type,
            payload=json.dumps(parameters or {}),
            status=ActionStatus.QUEUED,
            created_at=now,
            queued_at=now,
            created_by=created_by,
            execution_timeout_seconds=execution_timeout_seconds,
        )
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action

    def mark_sent(self, action: RemoteAction) -> RemoteAction:
        action.status = ActionStatus.SENT
        action.sent_at = utcnow()
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action

    def mark_acknowledged(self, action: RemoteAction) -> RemoteAction:
        action.status = ActionStatus.ACKNOWLEDGED
        action.acknowledged_at = utcnow()
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action

    def mark_running(self, action: RemoteAction) -> RemoteAction:
        action.status = ActionStatus.RUNNING
        action.started_at = utcnow()
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action

    def mark_completed(
        self,
        action: RemoteAction,
        result_message: Optional[str] = None,
        output: Optional[str] = None,
    ) -> RemoteAction:
        action.status = ActionStatus.COMPLETED
        action.completed_at = utcnow()
        action.result_message = result_message
        action.output = output
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action

    def mark_failed(
        self,
        action: RemoteAction,
        error_message: Optional[str] = None,
        stderr_output: Optional[str] = None,
    ) -> RemoteAction:
        action.status = ActionStatus.FAILED
        action.failed_at = utcnow()
        action.error_message = error_message
        action.stderr_output = stderr_output
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action

    def mark_cancelled(self, action: RemoteAction) -> RemoteAction:
        action.status = ActionStatus.CANCELLED
        action.cancelled_at = utcnow()
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action

    # ------------------------------------------------------------------ #
    # Lazy expiration                                                      #
    # ------------------------------------------------------------------ #

    def _expire_if_needed(self, action: RemoteAction) -> RemoteAction:
        if action.status not in EXPIRABLE_STATUSES:
            return action
        created_at = ensure_utc(action.created_at)
        if created_at is None:
            return action
        deadline = created_at + timedelta(seconds=action.execution_timeout_seconds)
        if utcnow() > deadline:
            logger.info("[action] expired action #%d (type=%s device=%d)", action.id, action.action_type, action.device_id)
            action.status = ActionStatus.EXPIRED
            action.expired_at = utcnow()
            self.db.add(action)
            self.db.commit()
            self.db.refresh(action)
        return action
