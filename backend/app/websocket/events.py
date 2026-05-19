from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional
from uuid import uuid4

from app.core.time import utcnow
from app.models.device import Device


def _iso(dt: Optional[datetime]) -> Optional[str]:
    """Serialize a datetime to ISO-8601 with UTC offset.

    DB columns use naive UTC.  Stamping with timezone.utc before isoformat()
    produces '…+00:00' so browsers parse it as UTC, not local time.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


class RealtimeEventType(str, Enum):
    CONNECTION_READY = "connection_ready"
    DEVICE_ONLINE = "device_online"
    DEVICE_OFFLINE = "device_offline"
    DEVICE_UPDATED = "device_updated"
    HEARTBEAT_RECEIVED = "heartbeat_received"
    DEPLOYMENT_EVENT = "deployment_event"
    SERVER_PING = "server_ping"
    RUSTDESK_UPDATED = "rustdesk_updated"
    RUSTDESK_ONLINE = "rustdesk_online"
    RUSTDESK_OFFLINE = "rustdesk_offline"
    SYNC_FAILED = "sync_failed"
    TELEMETRY_UPDATED = "telemetry_updated"
    HEALTH_WARNING = "health_warning"
    HEALTH_CRITICAL = "health_critical"
    HEALTH_RECOVERED = "health_recovered"
    ALERT_CREATED = "alert_created"
    ALERT_RESOLVED = "alert_resolved"
    ACTION_QUEUED = "action_queued"
    ACTION_STATUS_CHANGED = "action_status_changed"


def device_payload(device: Device) -> Dict[str, Any]:
    return {
        "id": device.id,
        "rustdesk_id": device.rustdesk_id,
        "hostname": device.hostname,
        "current_user": device.current_user,
        "domain": device.domain,
        "public_ip": device.public_ip,
        "local_ip": device.local_ip,
        "os_name": device.os_name,
        "os_version": device.os_version,
        "platform": device.platform,
        "device_type": device.device_type.value,
        "status": device.status.value,
        "freshness_state": device.freshness_state,
        "registered_at": _iso(device.registered_at),
        "last_seen": _iso(device.last_seen),
        "client_id": device.client_id,
        "group_id": device.group_id,
        "client_name": device.client_name,
        "group_name": device.group_name,
        "assignment_source": device.assignment_source,
        "resolved_client_id": getattr(device, "resolved_client_id", device.client_id),
        "resolved_client_name": getattr(device, "resolved_client_name", device.client_name),
        "resolved_group": getattr(device, "resolved_group", device.group_name),
        "resolved_assignment_source": getattr(device, "resolved_assignment_source", device.assignment_source or "unassigned"),
        "resolved_device_category": getattr(device, "resolved_device_category", "unassigned"),
        "is_archived": device.is_archived,
        "duplicate_candidate": device.duplicate_candidate,
        "duplicate_of_device_id": device.duplicate_of_device_id,
        "duplicate_score": device.duplicate_score,
        "is_in_maintenance": device.is_in_maintenance,
        "maintenance_ends_at": _iso(device.maintenance_ends_at),
        "maintenance_note": device.maintenance_note,
        "rustdesk_install_status": device.rustdesk_install_status,
        "rustdesk_status": device.rustdesk_status,
        "rustdesk_version": device.rustdesk_version,
        "rustdesk_install_path": device.rustdesk_install_path,
        "rustdesk_sync_state": device.rustdesk_sync_state,
        "rustdesk_sync_message": device.rustdesk_sync_message,
        "rustdesk_last_seen_at": _iso(device.rustdesk_last_seen_at),
        "rustdesk_synced_at": _iso(device.rustdesk_synced_at),
        "rustdesk_verified_at": _iso(device.rustdesk_verified_at),
        "rustdesk_manual_override": device.rustdesk_manual_override,
        "rustdesk_conflict_detected": device.rustdesk_conflict_detected,
        "rustdesk_last_repair_at": _iso(device.rustdesk_last_repair_at),
        "rustdesk_repair_count": device.rustdesk_repair_count,
    }


def build_event(
    event_type: RealtimeEventType,
    *,
    data: Dict[str, Any],
    tenant_id: str = "default",
    reason: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "event_id": str(uuid4()),
        "version": 1,
        "type": event_type.value,
        "tenant_id": tenant_id,
        "occurred_at": utcnow().isoformat(),
        "reason": reason,
        "data": data,
    }
