import logging
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.agent_auth import compute_callback_token
from app.core.time import utcnow
from app.models.device import Device
from app.models.remote_action import (
    ACTION_STAGE_ORDER,
    ACTION_STAGE_PERCENT,
    ActionStatus,
    RemoteAction,
    TERMINAL_STATUSES,
)
from app.repositories.remote_action_repository import RemoteActionRepository
from app.schemas.remote_action import (
    ACTION_CONFLICT_GROUPS,
    ActionStatusStats,
    ActionType,
    PendingActionDelivery,
    RemoteActionCreate,
)
from app.services.notification_events import NotificationEvent
from app.services.notification_service import NotificationService
from app.websocket.events import RealtimeEventType, build_event
from app.websocket.publisher import realtime_publisher

logger = logging.getLogger(__name__)

_ALLOWED_TYPES = {a.value for a in ActionType}


def _notify_action_result(db: Session, action: RemoteAction, *, failed: bool, message: str) -> None:
    device = db.query(Device).filter(Device.id == action.device_id).first()
    hostname = device.hostname if device else f"device-{action.device_id}"
    is_self_update = action.action_type == ActionType.SELF_UPDATE.value
    if failed:
        event_type = NotificationEvent.AGENT_UPDATE_FAILED if is_self_update else NotificationEvent.REMOTE_ACTION_FAILED
        severity = "warning"
        verb = "failed"
    else:
        event_type = NotificationEvent.AGENT_UPDATE_COMPLETED if is_self_update else NotificationEvent.REMOTE_ACTION_COMPLETED
        severity = "info"
        verb = "completed"
    NotificationService(db).dispatch(
        event_type=event_type,
        title=f"{action.action_type} {verb} on {hostname}",
        message=message,
        severity=severity,
        device_id=action.device_id,
        client_id=getattr(device, "client_id", None),
        payload={"action_id": action.id, "action_type": action.action_type},
    )


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
        "progress": action.progress,
        "stage": action.stage,
    }


def _publish_action_status(action: RemoteAction, event_type: RealtimeEventType) -> None:
    realtime_publisher.publish_threadsafe(
        build_event(event_type, data=_action_event_payload(action), reason="action_status_changed"),
        # Keyed on the status too: over the command channel an action goes
        # sent → acknowledged → completed within a second, and a key per
        # action dropped every step after the first, leaving pages on "Sent".
        # And on stage + progress: progress reports keep the status "running"
        # and would otherwise all be dropped after the first.
        dedupe_key=(
            f"action_status:{action.id}:{getattr(action.status, 'value', action.status)}"
            f":{getattr(action, 'stage', None)}:{getattr(action, 'progress', None)}"
        ),
    )


# What result_message says when a stage starts without a message of its own.
_STAGE_MESSAGES = {
    "downloading": "Downloading the update",
    "verifying": "Verifying the download",
    "installing": "Installing the update",
    "restarting": "Restarting the agent service",
    "confirming": "Agent back; confirming the new version",
}

# Progress is accepted while the agent works on the action.
_PROGRESS_STATUSES = {ActionStatus.SENT, ActionStatus.ACKNOWLEDGED, ActionStatus.RUNNING}

# A self_update the agent is working on: the command channel dropping (the
# service restarting) and returning say how far it got, for any agent version.
_CHANNEL_STAGE_STATUSES = (ActionStatus.ACKNOWLEDGED, ActionStatus.RUNNING)


def _mark_progress_complete(action: RemoteAction) -> None:
    """A completed action with progress shows 100 and no stage."""
    if action.progress is not None or action.action_type == ActionType.SELF_UPDATE.value:
        action.progress = 100
        action.stage = None


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


def _self_update_target_sha(payload: dict) -> str:
    return (payload.get("target_sha256") or payload.get("sha256") or "").strip().lower()


class ActionConflictError(ValueError):
    """A new action would clash with one still queued or running on the
    device; carries that action so the console can offer to cancel it."""

    def __init__(self, message: str, action: RemoteAction):
        super().__init__(message)
        self.action_id = action.id
        self.action_type = action.action_type
        self.status = getattr(action.status, "value", action.status)

    def detail(self) -> dict:
        return {"code": "action_conflict", "detail": str(self), "action_id": self.action_id,
                "action_type": self.action_type, "status": self.status}


def _check_conflicts(existing_actions: List[RemoteAction], new_type: str) -> Optional[Tuple[str, RemoteAction]]:
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
                "Cancel or wait for it to finish before queuing another.",
                action,
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
                    "Cancel the conflicting action first.",
                    action,
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
        conflict = _check_conflicts(recent, create_in.action_type.value)
        if conflict:
            raise ActionConflictError(*conflict)

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
        if action.action_type == ActionType.SELF_UPDATE.value and not self._self_update_verified(action):
            action.status = ActionStatus.RUNNING
            if action.started_at is None:
                action.started_at = utcnow()
            if action.stage is None:
                # An agent reporting progress (2.1.32+) has already said more
                # than this; keep its latest message.
                action.result_message = "Self-update initiated; awaiting heartbeat verification"
            action.output = output
            self.repo.db.add(action)
            self.repo.db.commit()
            self.repo.db.refresh(action)
            logger.info("[action] self_update #%d awaiting heartbeat verification", action_id)
            _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
            return action
        _mark_progress_complete(action)
        action = self.repo.mark_completed(action, result_message=result_message, output=output)
        logger.info("[action] completed #%d result=%r", action_id, result_message)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        _record_audit(self.repo.db, action, f"Action completed: {action.action_type}")
        _notify_action_result(self.repo.db, action, failed=False, message=result_message or f"Action completed: {action.action_type}")
        return action

    def report_progress(
        self,
        action_id: int,
        stage: str,
        percent: Optional[int] = None,
        message: Optional[str] = None,
    ) -> Optional[RemoteAction]:
        """Agent progress for an action it is working on.

        Moves a sent/acknowledged action to running. Never moves back: a
        report for an earlier stage, or a lower percent within the same stage
        (a download retry), changes nothing. percent is the overall percent;
        without one the stage's starting percent is used (or the current
        one, if higher).
        """
        action = self.repo.get(action_id)
        if not action:
            return None
        if action.status not in _PROGRESS_STATUSES:
            raise ValueError(f"Cannot report progress in status: {action.status.value}")
        if stage not in ACTION_STAGE_ORDER:
            raise ValueError(f"Unknown progress stage: {stage}")

        changed = False
        if action.status != ActionStatus.RUNNING:
            now = utcnow()
            if action.acknowledged_at is None:
                action.acknowledged_at = now
            if action.started_at is None:
                action.started_at = now
            action.status = ActionStatus.RUNNING
            changed = True

        current_order = ACTION_STAGE_ORDER.get(action.stage or "", -1)
        new_order = ACTION_STAGE_ORDER[stage]
        current = action.progress or 0
        backwards = new_order < current_order or (
            new_order == current_order and percent is not None and percent < current
        )
        if not backwards:
            target = percent if percent is not None else ACTION_STAGE_PERCENT[stage]
            # 100 means completed, which only the server decides.
            target = min(max(target, current), 99)
            text = (message or "").strip()[:200] or (
                _STAGE_MESSAGES[stage] if stage != action.stage else action.result_message
            )
            if (action.progress, action.stage, action.result_message) != (target, stage, text):
                action.progress, action.stage, action.result_message = target, stage, text
                changed = True

        if not changed:
            return action
        self.repo.db.add(action)
        self.repo.db.commit()
        self.repo.db.refresh(action)
        logger.debug("[action] progress #%d %s %s%%", action.id, action.stage, action.progress)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        return action

    def note_command_channel(self, device_id: int, connected: bool) -> None:
        """The device's command channel closed or opened.

        A self_update the agent is working on restarts the agent service, which
        drops the channel: that is the "restarting" stage. The channel (or a
        heartbeat, see verify_self_update_for_device) coming back while the
        update is not yet verified is "confirming". Works for agents that do
        not report progress. A drop while a progress-reporting agent is still
        downloading or verifying is a network blip, not the restart.
        """
        actions = self._open_self_updates(device_id)
        for action in actions:
            if connected:
                if action.stage == "restarting":
                    self._set_server_stage(action, "confirming")
            elif action.stage in (None, "installing"):
                self._set_server_stage(action, "restarting")

    def _open_self_updates(self, device_id: int) -> List[RemoteAction]:
        return (
            self.repo.db.query(RemoteAction)
            .filter(
                RemoteAction.device_id == device_id,
                RemoteAction.action_type == ActionType.SELF_UPDATE.value,
                RemoteAction.status.in_(_CHANNEL_STAGE_STATUSES),
            )
            .order_by(RemoteAction.created_at.desc())
            .limit(10)
            .all()
        )

    def _set_server_stage(self, action: RemoteAction, stage: str) -> None:
        action.stage = stage
        action.progress = max(action.progress or 0, ACTION_STAGE_PERCENT[stage])
        action.result_message = _STAGE_MESSAGES[stage]
        self.repo.db.add(action)
        self.repo.db.commit()
        self.repo.db.refresh(action)
        logger.info("[action] self_update #%d on device #%d: %s", action.id, action.device_id, stage)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)

    def verify_self_update_for_device(self, device_id: int) -> None:
        actions = self._open_self_updates(device_id)
        for action in actions:
            if action.status != ActionStatus.RUNNING or not self._self_update_verified(action):
                # A heartbeat after the restart: the agent is back, the new
                # version not (yet) confirmed.
                if action.stage == "restarting":
                    self._set_server_stage(action, "confirming")
                continue
            target_sha = _self_update_target_sha(action.payload_dict)
            _mark_progress_complete(action)
            action = self.repo.mark_completed(
                action,
                result_message=f"Self-update verified by heartbeat sha256={target_sha[:12]}",
                output=action.output,
            )
            logger.info("[action] self_update #%d verified by heartbeat", action.id)
            _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
            _record_audit(self.repo.db, action, "Action completed: self_update verified by heartbeat")
            _notify_action_result(
                self.repo.db, action, failed=False,
                message=f"Self-update verified by heartbeat sha256={target_sha[:12]}",
            )

    def _self_update_verified(self, action: RemoteAction) -> bool:
        payload = action.payload_dict
        target_version = (payload.get("version") or "").strip()
        target_sha = _self_update_target_sha(payload)
        device = self.repo.db.query(Device).filter(Device.id == action.device_id).first()
        if device is None:
            return False
        if target_version and (device.agent_version or "").strip() != target_version:
            return False
        if target_sha and (device.agent_sha256 or "").strip().lower() != target_sha:
            return False
        return bool(target_version or target_sha)

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
        _notify_action_result(self.repo.db, action, failed=True, message=error_message or "no detail")
        return action

    # ------------------------------------------------------------------ #
    # Heartbeat delivery                                                   #
    # ------------------------------------------------------------------ #

    def build_delivery(self, action: RemoteAction) -> PendingActionDelivery:
        """Build an action's delivery payload **without changing its status**.

        Split out from deliver_now so a caller can put the frame on the wire
        before committing to it. Marking an action SENT is not reversible in
        practice: the heartbeat path only collects QUEUED work, so an action
        marked SENT that was never actually delivered is delivered by nobody.
        """
        return PendingActionDelivery(
            action_id=action.id,
            action=action.action_type,
            parameters=action.payload_dict,
            timeout_seconds=action.execution_timeout_seconds,
            callback_secret=compute_callback_token(action.id),
        )

    def mark_delivered(self, action: RemoteAction) -> RemoteAction:
        """Record that an action reached the agent over the command channel.

        Call this only once delivery is confirmed. Same bookkeeping as
        collect_pending_for_delivery does per heartbeat — it is what stops the
        next heartbeat from delivering the same action a second time and
        opening two terminals.
        """
        action = self.repo.mark_sent(action)
        _publish_action_status(action, RealtimeEventType.ACTION_STATUS_CHANGED)
        logger.info(
            "[action] pushed #%d (type=%s) to device #%d over the command channel",
            action.id, action.action_type, action.device_id,
        )
        return action

    def deliver_now(self, action: RemoteAction) -> PendingActionDelivery:
        """Mark one action SENT and build its delivery payload.

        Retained for callers that deliver and commit in one step. Prefer
        build_delivery + mark_delivered when the delivery can fail.
        """
        delivery = self.build_delivery(action)
        self.mark_delivered(action)
        return delivery

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
