from typing import List

from app.models.alert import AlertKind, DeviceAlert
from app.models.device import Device
from app.models.remote_action import ActionStatus, RemoteAction
from app.repositories.device_activity_event_repository import DeviceActivityEventRepository
from app.repositories.device_heartbeat_repository import DeviceHeartbeatRepository
from app.repositories.device_status_history_repository import DeviceStatusHistoryRepository
from app.schemas.activity import ActivityEvent


_REASON_LABELS: dict = {
    "heartbeat_received": "Heartbeat",
    "heartbeat_timeout_exceeded": "Timeout exceeded",
    "manual": "Manual action",
}


class DeviceActivityService:
    def __init__(self, db):
        self.db = db
        self.event_repo = DeviceActivityEventRepository(db)
        self.heartbeat_repo = DeviceHeartbeatRepository(db)
        self.history_repo = DeviceStatusHistoryRepository(db)

    def get_activity_feed(self, device_id: int, limit: int = 40) -> List[ActivityEvent]:
        device = self.db.query(Device).filter(Device.id == device_id).first()
        heartbeats = self.heartbeat_repo.get_recent_by_device(device_id, limit=limit)
        status_history = self.history_repo.get_recent_by_device(device_id, limit=limit)
        stored_events = self.event_repo.get_recent_by_device(device_id, limit=limit)
        remote_actions = (
            self.db.query(RemoteAction)
            .filter(RemoteAction.device_id == device_id)
            .order_by(RemoteAction.created_at.desc())
            .limit(limit)
            .all()
        )
        archived_checkins = (
            self.db.query(DeviceAlert)
            .filter(DeviceAlert.device_id == device_id, DeviceAlert.kind == AlertKind.ARCHIVED_CHECKIN.value)
            .order_by(DeviceAlert.created_at.desc())
            .limit(limit)
            .all()
        )

        events: List[ActivityEvent] = []

        if device and device.registered_at:
            events.append(ActivityEvent(
                id=f"dev-registered-{device.id}",
                type="device_registered",
                occurred_at=device.registered_at,
                summary="Device registered",
                detail=device.rustdesk_id,
                device_id=device_id,
            ))

        if device and device.duplicate_candidate:
            detail = None
            if device.duplicate_of_device_id:
                detail = f"Possible match with Device #{device.duplicate_of_device_id}"
            events.append(ActivityEvent(
                id=f"dup-{device.id}",
                type="duplicate_candidate",
                occurred_at=device.registered_at,
                summary="Duplicate candidate detected",
                detail=detail,
                device_id=device_id,
            ))

        for ev in stored_events:
            events.append(ActivityEvent(
                id=f"ev-{ev.id}",
                type=ev.event_type,
                occurred_at=ev.occurred_at,
                summary=ev.summary,
                detail=ev.detail,
                actor=ev.actor,
                device_id=device_id,
            ))

        for hb in heartbeats:
            events.append(ActivityEvent(
                id=f"hb-{hb.id}",
                type="heartbeat_received",
                occurred_at=hb.created_at,
                summary="Heartbeat received",
                detail=hb.current_user or hb.hostname,
                device_id=device_id,
            ))

        offline_reason = getattr(device, "offline_reason", None) if device else None
        offline_confidence = getattr(device, "offline_confidence", None) if device else None
        for sh in status_history:
            is_online = sh.new_status.value == "online"
            if not is_online and offline_reason:
                confidence_label = f" · Confidence: {offline_confidence.capitalize()}" if offline_confidence else ""
                detail = f"Likely reason: {offline_reason.replace('_', ' ').title()}{confidence_label}"
            else:
                detail = _REASON_LABELS.get(sh.reason, sh.reason) if sh.reason else None
            events.append(ActivityEvent(
                id=f"st-{sh.id}",
                type="device_online" if is_online else "device_offline",
                occurred_at=sh.created_at,
                summary="Device came online" if is_online else "Device went offline",
                detail=detail,
                device_id=device_id,
            ))

        for action in remote_actions:
            actor_detail = f"by {action.created_by}" if action.created_by else None
            events.append(ActivityEvent(
                id=f"actq-{action.id}",
                type="action_queued",
                occurred_at=action.queued_at or action.created_at,
                summary=f"Action queued: {action.action_type}",
                detail=actor_detail,
                device_id=device_id,
            ))
            if action.status == ActionStatus.COMPLETED and action.completed_at:
                events.append(ActivityEvent(
                    id=f"actc-{action.id}",
                    type="action_completed",
                    occurred_at=action.completed_at,
                    summary=f"Action completed: {action.action_type}",
                    detail=action.result_message,
                    device_id=device_id,
                ))
            if action.status == ActionStatus.FAILED and action.failed_at:
                events.append(ActivityEvent(
                    id=f"actf-{action.id}",
                    type="action_failed",
                    occurred_at=action.failed_at,
                    summary=f"Action failed: {action.action_type}",
                    detail=action.error_message,
                    device_id=device_id,
                ))

        for alert in archived_checkins:
            events.append(ActivityEvent(
                id=f"arch-checkin-{alert.id}",
                type="archived_checkin",
                occurred_at=alert.created_at,
                summary="Archived check-in alert",
                detail=alert.detail or alert.message,
                device_id=device_id,
            ))

        events.sort(key=lambda e: e.occurred_at, reverse=True)
        return events[:limit]
