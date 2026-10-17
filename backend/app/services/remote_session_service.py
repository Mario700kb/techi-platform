"""Remote Support (RustDesk) sessions, as reported by the agent or by RustDesk.

RustDesk itself reports each connection to /api/audit/conn (see
rustdesk_audit_service), to the second. The agent reports in each heartbeat whether a session is live (RustDesk runs
its connection manager for every incoming session). A change starts or ends
the session's audit record; it is attributed to the operator who asked for
the device's Connect link shortly before, the only link between a click in
the console and a RustDesk session. Heartbeats are ~5 minutes apart, so start,
end and duration are accurate to about that.
"""
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.repositories.audit_log_repository import AuditLogRepository
from app.services.audit_service import AuditAction
from app.services.device_activity_event_service import DeviceActivityEventService

logger = logging.getLogger(__name__)

# A Connect click this long before a session starts is taken as its origin.
ATTRIBUTION_WINDOW = timedelta(minutes=15)

# While RustDesk's own second-accurate reports have arrived this recently, the
# agent's coarse per-beat flag does not touch the session: RustDesk is the
# authority and the two writers would otherwise fight.
RUSTDESK_AUTHORITY_WINDOW = timedelta(minutes=15)


class RemoteSessionService:
    def __init__(self, db: Session):
        self.db = db

    def apply_report(
        self,
        device: Device,
        active: Optional[bool],
        *,
        now: Optional[datetime] = None,
        details: Optional[dict] = None,
        source: str = "heartbeat",
    ) -> None:
        if active is None:
            return
        now = ensure_utc(now or utcnow())
        if source == "heartbeat" and self._rustdesk_is_authoritative(device, now):
            # RustDesk's own reports are driving this device's sessions; the
            # agent's coarse flag must not start or end anything meanwhile.
            return
        if source == "rustdesk":
            device.rustdesk_last_report_at = now.replace(tzinfo=None)
            self.db.add(device)
        if bool(active) == bool(device.rustdesk_session_active):
            if source == "rustdesk":
                self.db.commit()
            return
        if active:
            self._start(device, now, details or {}, source=source)
        else:
            self._end(device, now, reason="session_closed", extra=details or {}, source=source)

    def _rustdesk_is_authoritative(self, device: Device, now: datetime) -> bool:
        last = ensure_utc(device.rustdesk_last_report_at)
        return last is not None and (now - last) < RUSTDESK_AUTHORITY_WINDOW

    def end_if_active(self, device: Device, *, reason: str, now: Optional[datetime] = None) -> None:
        if device.rustdesk_session_active:
            self._end(device, ensure_utc(now or utcnow()), reason=reason)

    def _start(self, device: Device, now: datetime, extra: Optional[dict] = None, *, source: str = "heartbeat") -> None:
        connect = self._last_connect_request(device, now)
        operator_id = connect.operator_id if connect else None
        operator = connect.operator_username if connect else None
        device.rustdesk_session_active = True
        device.rustdesk_session_started_at = now.replace(tzinfo=None)
        device.rustdesk_session_operator = operator
        device.rustdesk_session_source = source
        self.db.add(device)
        self.db.commit()
        details = {
            "hostname": device.hostname,
            "techi_remote_id": device.rustdesk_id,
            "attribution": "connect_request" if connect else "unattributed",
            **(extra or {}),
        }
        if connect:
            details["connect_requested_at"] = ensure_utc(connect.created_at).isoformat()
            details["ip"] = (json.loads(connect.details_json or "{}") or {}).get("ip")
        self._audit(AuditAction.REMOTE_SESSION_STARTED, device, operator_id, operator, details)
        DeviceActivityEventService(self.db).record(
            device_id=device.id,
            event_type="remote_session_started",
            summary="Remote session started",
            detail=(f"By {operator}" if operator else "No Connect request from the console just before it")
            + (f" · from {extra['peer_name']}" if (extra or {}).get("peer_name") else ""),
            actor=operator or "unknown",
            fail_silently=True,
        )

    def _end(self, device: Device, now: datetime, *, reason: str, extra: Optional[dict] = None, source: str = "heartbeat") -> None:
        started = ensure_utc(device.rustdesk_session_started_at)
        minutes = max(0, round((now - started).total_seconds() / 60)) if started else None
        operator = device.rustdesk_session_operator
        connect = self._last_connect_request(device, started or now)
        device.rustdesk_session_active = False
        device.rustdesk_session_started_at = None
        device.rustdesk_session_operator = None
        device.rustdesk_session_source = None
        self.db.add(device)
        self.db.commit()
        self._audit(
            AuditAction.REMOTE_SESSION_ENDED,
            device,
            connect.operator_id if connect and connect.operator_username == operator else None,
            operator,
            {
                "hostname": device.hostname,
                "techi_remote_id": device.rustdesk_id,
                "duration_minutes": minutes,
                "started_at": started.isoformat() if started else None,
                # When it really ended; the entry itself can be written later
                # (a lost close noticed at the next heartbeat).
                "ended_at": now.isoformat(),
                "reason": reason,
                **(extra or {}),
            },
        )
        DeviceActivityEventService(self.db).record(
            device_id=device.id,
            event_type="remote_session_ended",
            summary="Remote session ended",
            detail=(f"After about {minutes} min" if minutes is not None else "Duration unknown")
            + (f" · {operator}" if operator else "")
            + (" · device went offline" if reason == "device_offline" else ""),
            actor=operator or "unknown",
            fail_silently=True,
        )

    def _last_connect_request(self, device: Device, before: datetime) -> Optional[AuditLog]:
        before_naive = before.replace(tzinfo=None)
        return (
            self.db.query(AuditLog)
            .filter(
                AuditLog.action == AuditAction.REMOTE_CONNECT,
                AuditLog.entity_type == "device",
                AuditLog.entity_id == device.id,
                AuditLog.created_at >= before_naive - ATTRIBUTION_WINDOW,
                AuditLog.created_at <= before_naive,
            )
            .order_by(AuditLog.created_at.desc())
            .first()
        )

    def _audit(self, action: str, device: Device, operator_id, operator, details: dict) -> None:
        # Straight to the repository: audit_log() would stamp the agent's IP
        # (this runs inside the heartbeat request), which is not the operator's.
        try:
            AuditLogRepository(self.db).create(
                operator_id=operator_id,
                operator_username=operator or "unknown",
                action=action,
                entity_type="device",
                entity_id=device.id,
                details=details,
            )
        except Exception:
            logger.exception("remote session audit failed device=%s action=%s", device.id, action)
