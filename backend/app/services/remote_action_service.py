import logging
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.agent_auth import compute_callback_token
from app.models.remote_action import ActionStatus, RemoteAction, TERMINAL_STATUSES
from app.repositories.remote_action_repository import RemoteActionRepository
from app.schemas.remote_action import (
    ACTION_CONFLICT_GROUPS,
    ActionStatusStats,
    ActionType,
    PendingActionDelivery,
    RemoteActionCreate,
)
from app.websocket.events import RealtimeEventType, build_event
from app.websocket.publisher import realtime_publisher

logger = logging.getLogger(__name__)

_ALLOWED_TYPES = {a.value for a in ActionType}


def _action_event_payload(action: RemoteAction) -> dict:
    return {
        "id": action.id,
        "device_id": action.device_id,
        "action_type": action.action_type,
        "status": action.status.value,
        "created_at": action.created_at.isoformat(),
        "created_by": action.created_by,
        "queued_at": action.queued_at.isoformat() if action.queued_at else None,
        "sent_at": action.sent_at.isoformat() if action.sent_at else None,
        "acknowledged_at": action.acknowledged_at.isoformat() if action.acknowledged_at else None,
        "started_at": action.started_at.isoformat() if action.started_at else None,
        "completed_at": action.completed_at.isoformat() if action.completed_at else None,
        "failed_at": action.failed_at.isoformat() if action.failed_at else None,
        "cancelled_at": action.cancelled_at.isoformat() if action.cancelled_at else None,
        "expired_at": action.expired_at.isoformat() if action.expired_at else None,
        "result_message": action.result_message,
        "error_message": action.error_message,
        "output": action.output,
        "stderr_output": action.stderr_output,
        "execution_timeout_seconds": action.execution_timeout_seconds,
    }


def _publish_action_status(action: RemoteAction, event_type: RealtimeEventType) -> None:
    realtime_publisher.publish_threadsafe(
        build_event(event_type, data=_action_event_payload(action), reason="action_status_changed"),
        dedupe_key=f"action_status:{action.id}",
    )


def _record_audit(db: Session, action: RemoteAction, summary: str, actor: Optional[str] = None) -> None:
    try:
        from app.services.device_activity_event_service import DeviceActivityEventService
        DeviceActivityEventService(db).record(
            device_id=action.device_id,
            event_type="remote_action",
            summary=summary,
            detail=f"action_id={action.id} type={action.action_type}",
            actor=actor or action.created_by,
            fail_silently=True,
        )
    except Exception:
        logger.debug("audit record skipped", exc_info=True)


def _check_conflicts(existing_actions: List[RemoteAction], new_type: str) -> Optional[str]:
    """
    Return an error message if new_type conflicts with any active (non-terminal)
    action in existing_actions, otherwise None.

    Two action types conflict when they belong to the same conflict group.
    A duplicate of the exact same type is always blocked.
    """
    active = [a for a in existing_actions if a.status not in TERMINAL_STATUSES]
    if not active:
        return None

    new_enum: Optional[ActionType] = None
    try:
        new_enum = ActionType(new_type)
    except ValueError:
        # Unknown type — no conflict check possible.
        return None

    for action in active:
        existing_type = action.action_type

        if existing_type == new_type:
            return (
                f"A '{new_type}' action is already queued or running "
                f"(action #{action.id}, status={action.status.value}). "
                "Cancel or wait for it to finish before queuing another."
            )

        try:
            existing_enum = ActionType(existing_type)
        except ValueError:
            continue

        for group in ACTION_CONFLICT_GROUPS:
            if new_enum in group and existing_enum in group:
                return (
                    f"Cannot queue '{new_type}': conflicts with active '{existing_type}' "
                    f"(action #{action.id}, status={action.status.value}). "
                    "Cancel the conflicting action first."
                )

    return None


class RemoteActionService:
    def __init__(self, db: Session):
        self.repo = RemoteActionRepository(db)

    # ------------------------------------------------------------------ #
    # Operator interface                                                   #
    # ------------------------------------------------------------------ #

    def queue_action(self, device_id: int, create_in: RemoteActionCreate) -> RemoteAction:
        if create_in.action_type.value not in _ALLOWED_TYPES:
            raise ValueError(f"Unsupported action type: {create_in.action_type}")

        # Conflict / duplicate guard — check all recent actions for this device.
        recent = self.repo.get_recent_for_device(device_id, limit=50)
        conflict_msg = _check_conflicts(recent, create_in.action_type.value)
        if conflict_msg:
            raise ValueError(conflict_msg)

        action = self.repo.create(
            device_id=device_id,
            action_type=create_in.action_type.value,
            parameters=create_in.parameters,
            created_by=create_in.created_by,
            execution_timeout_seconds=create_in.execution_timeout_seconds or 300,
        )
        logger.info(
            "[action] queued #%d type=%s device=%d by=%s",
            action.id, action.action_type, device_id, create_in.created_by,
        )
        _publish_action_status(action, RealtimeEventType.ACTION_QUEUED)
        _record_audit(self.repo.db, action, f"Action queued: {action.action_type}", actor=create_in.created_by)
        return action

    def get_recent(self, device_id: int, limit: int = 30) -> List[RemoteAction]:
        return self.repo.get_recent_for_device(device_id, limit=limit)

    def get_filtered(
        self,
        device_id: int,
        status: Optional[str] = None,
        limit: int = 30,
    ) -> List[RemoteAction]:
        return self.repo.get_filtered_for_device(device_id, status=status, limit=limit)

    def get_stats(self, device_id: int) -> ActionStatusStats:
        counts = self.repo.get_stats_for_device(device_id)
        total = sum(counts.values())
        return ActionStatusStats(total=total, **{k: counts.get(k, 0) for k in ActionStatusStats.model_fields if k != "total"})

    def get_recent_global(self, limit: int = 20) -> List[RemoteAction]:
        return self.repo.get_recent_global(limit=limit)

    def cancel_action(self, action_id: int) -> Optional[RemoteAction]:
        action = self.repo.get(action_id)
        if not action:
            return None
        if action.status in TERMINAL_STATUSES:
            raise ValueError(f"Cannot cancel action in terminal status: {action.status.value}")
        action = self.repo.mark_cancelled(action)
        logger.info("[action] cancelled #%d", action_id)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        _record_audit(self.repo.db, action, f"Action cancelled: {action.action_type}")
        return action

    def retry_action(self, action_id: int, caller_username: Optional[str] = None) -> RemoteAction:
        original = self.repo.get(action_id)
        if not original:
            raise ValueError("Action not found")
        if original.status not in TERMINAL_STATUSES:
            raise ValueError(f"Cannot retry action in non-terminal status: {original.status.value}")
        create_in = RemoteActionCreate(
            action_type=ActionType(original.action_type),
            parameters=original.payload_dict or None,
            created_by=caller_username or original.created_by,
            execution_timeout_seconds=original.execution_timeout_seconds,
        )
        return self.queue_action(original.device_id, create_in)

    # ------------------------------------------------------------------ #
    # Agent interface                                                      #
    # ------------------------------------------------------------------ #

    def acknowledge(self, action_id: int) -> Optional[RemoteAction]:
        action = self.repo.get(action_id)
        if not action:
            return None
        if action.status not in {ActionStatus.SENT, ActionStatus.QUEUED}:
            raise ValueError(f"Cannot acknowledge action in status: {action.status.value}")
        action = self.repo.mark_acknowledged(action)
        logger.info("[action] acked #%d device=%d", action_id, action.device_id)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        return action

    def mark_running(self, action_id: int) -> Optional[RemoteAction]:
        action = self.repo.get(action_id)
        if not action:
            return None
        if action.status in TERMINAL_STATUSES:
            raise ValueError(f"Cannot mark running in terminal status: {action.status.value}")
        action = self.repo.mark_running(action)
        logger.info("[action] running #%d device=%d", action_id, action.device_id)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        return action

    def complete(
        self,
        action_id: int,
        result_message: Optional[str] = None,
        output: Optional[str] = None,
    ) -> Optional[RemoteAction]:
        action = self.repo.get(action_id)
        if not action:
            return None
        if action.status in TERMINAL_STATUSES:
            raise ValueError(f"Cannot complete action in terminal status: {action.status.value}")
        action = self.repo.mark_completed(action, result_message=result_message, output=output)
        logger.info("[action] completed #%d result=%r", action_id, result_message)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        _record_audit(self.repo.db, action, f"Action completed: {action.action_type}")
        return action

    def fail(
        self,
        action_id: int,
        error_message: Optional[str] = None,
        stderr_output: Optional[str] = None,
    ) -> Optional[RemoteAction]:
        action = self.repo.get(action_id)
        if not action:
            return None
        if action.status in TERMINAL_STATUSES:
            raise ValueError(f"Cannot fail action in terminal status: {action.status.value}")
        action = self.repo.mark_failed(action, error_message=error_message, stderr_output=stderr_output)
        logger.info("[action] failed #%d error=%r", action_id, error_message)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        _record_audit(
            self.repo.db, action,
            f"Action failed: {action.action_type} — {error_message or 'no detail'}",
        )
        return action

    # ------------------------------------------------------------------ #
    # Heartbeat delivery                                                   #
    # ------------------------------------------------------------------ #

    def collect_pending_for_delivery(self, device_id: int) -> List[PendingActionDelivery]:
        """
        Called on every agent heartbeat.

        Returns pending actions ready for delivery and marks each as SENT
        so they are not re-delivered on the next heartbeat.
        """
        pending = self.repo.get_pending_for_device(device_id)
        deliveries: List[PendingActionDelivery] = []
        for action in pending:
            action = self.repo.mark_sent(action)
            _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
            deliveries.append(
                PendingActionDelivery(
                    action_id=action.id,
                    action=action.action_type,
                    parameters=action.payload_dict,
                    timeout_seconds=action.execution_timeout_seconds,
                    callback_secret=compute_callback_token(action.id),
                )
            )
            logger.info(
                "[action] sent #%d (type=%s) to device #%d",
                action.id, action.action_type, device_id,
            )
        return deliveries
