"""Connection reports RustDesk on the devices posts to the API server.

RustDesk (TECHI Remote Support) posts every incoming connection to
/api/audit/conn — opened, password accepted, closed — and refused logins to
/api/audit/alarm. They carry no credential, so a report counts only when its
RustDesk ID belongs to a device and it comes from the public IP that device's
agent reports from (the server has no IPv6 address, so both arrive over the
same IPv4 path). Anything else is dropped.

A connection whose password was accepted starts the device's Remote Support
session (RemoteSessionService); the last such connection closing ends it.
"""
import json
import logging
from datetime import timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow, utcnow_naive
from app.models.device import Device
from app.models.device_activity_event import DeviceActivityEvent
from app.models.remote_support_connection import RemoteSupportConnection
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.device_repository import DeviceRepository
from app.repositories.remote_support_connection_repository import RemoteSupportConnectionRepository
from app.schemas.rustdesk_audit import RustDeskAlarmReport, RustDeskConnReport
from app.services.audit_service import AuditAction
from app.services.device_activity_event_service import DeviceActivityEventService
from app.services.remote_session_service import RemoteSessionService
from app.services.rustdesk_service import RustDeskIdentityService

logger = logging.getLogger(__name__)

CONNECTION_TYPES = {
    0: "remote desktop",
    1: "file transfer",
    2: "port forward",
    3: "camera",
    4: "terminal",
}

ALARM_TYPES = {
    0: "address not on the allow list",
    1: "more than 30 wrong passwords",
    2: "more than 6 wrong passwords in a minute",
    6: "too many attempts from one IPv6 prefix",
}

# A close RustDesk never sent (service restart, crash) stops holding the
# session open after this long.
OPEN_CONNECTION_LIMIT = timedelta(hours=12)

# A connection younger than this is not called lost on the agent's word.
LOST_GRACE = timedelta(minutes=2)

# RustDesk repeats an alarm while the caller keeps trying; the same alarm from
# the same caller on the same device is recorded once in this window.
ALARM_REPEAT_WINDOW = timedelta(minutes=10)


def _text(value, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] or None


class RustDeskAuditService:
    def __init__(self, db: Session):
        self.db = db
        self.connections = RemoteSupportConnectionRepository(db)

    def record_connection(self, report: RustDeskConnReport, source_ip: Optional[str]) -> bool:
        device = self._reporting_device(report.id, source_ip)
        if device is None:
            return False
        now = utcnow_naive()

        if report.action == "new":
            # A new connection with this conn_id means any still-open one with
            # the same id was lost (RustDesk restarted, or its close never
            # arrived); close it so it cannot hold a session open for 12 h.
            self.connections.close_open_for_conn(device.id, report.conn_id, now=now, reason="lost")
            self.connections.add(
                RemoteSupportConnection(
                    device_id=device.id,
                    conn_id=report.conn_id,
                    session_id=_text(report.session_id, 32),
                    peer_ip=_text(report.ip, 64),
                    opened_at=now,
                )
            )
            self.db.commit()
            self._sync_session(device, now)
            return True

        if report.peer is not None:
            connection = self.connections.latest_open(device.id, report.conn_id) or self.connections.add(
                RemoteSupportConnection(
                    device_id=device.id,
                    conn_id=report.conn_id,
                    session_id=_text(report.session_id, 32),
                    opened_at=now,
                )
            )
            connection.authorized_at = now
            connection.peer_id = _text(report.peer[0] if report.peer else None, 64)
            connection.peer_name = _text(report.peer[1] if len(report.peer) > 1 else None, 128)
            connection.conn_type = report.type
            self.db.commit()
            self._sync_session(device, now, details=self._session_details(connection))
            return True

        if report.action == "close":
            connection = self.connections.latest_open(device.id, report.conn_id)
            if connection is None:
                return False
            connection.closed_at = now
            connection.close_reason = "closed"
            self.db.commit()
            self._sync_session(device, now, details=self._session_details(connection))
            return True

        return False

    def close_lost_connections(self, device, now) -> int:
        """The device's agent reports no Remote Support session running (its
        connection-manager process is gone), yet connections are still open
        here: their close reports never arrived (sent while the platform was
        restarting, or RustDesk was killed). Close them as lost and end the
        session at RustDesk's last report — the real end — rather than now.

        Connections opened in the last LOST_GRACE are left alone: the agent's
        view can be a moment behind a connection that just opened."""
        stale = self.connections.open_before(device.id, now - LOST_GRACE)
        if not stale:
            return 0
        last_report = device.rustdesk_last_report_at
        newest_open = max(c.opened_at for c in stale)
        ended = last_report if last_report is not None and last_report >= newest_open else now
        ended = min(ended, now)
        for connection in stale:
            connection.closed_at = max(connection.opened_at, ended)
            connection.close_reason = "lost"
        self.db.commit()
        logger.info("rustdesk audit: device %s had %d connection(s) left open; closed as lost", device.id, len(stale))
        self._sync_session(device, ended, details={"close_report": "lost"})
        return len(stale)

    def _sync_session(self, device, now, details: Optional[dict] = None) -> None:
        """Drive the device's session flag from the open authorized connections:
        active while at least one is open, ended once the last closes. Derived
        from the rows, so a lost close or an out-of-order report self-corrects."""
        active = self.connections.count_open_authorized(device.id, since=now - OPEN_CONNECTION_LIMIT) > 0
        RemoteSessionService(self.db).apply_report(device, active, now=now, details=details, source="rustdesk")

    def record_alarm(self, report: RustDeskAlarmReport, source_ip: Optional[str]) -> bool:
        device = self._reporting_device(report.id, source_ip)
        if device is None:
            return False
        try:
            info = json.loads(report.info or "{}")
        except ValueError:
            info = {}
        if not isinstance(info, dict):
            info = {}
        reason = ALARM_TYPES.get(report.typ, f"alarm {report.typ}")
        caller = _text(info.get("name"), 128) or _text(info.get("id"), 64)
        caller_ip = _text(info.get("ip"), 64)
        detail = " · ".join(part for part in (reason, caller, caller_ip) if part)
        if self._alarm_recorded_recently(device.id, detail):
            return False
        AuditLogRepository(self.db).create(
            operator_id=None,
            operator_username="rustdesk",
            action=AuditAction.REMOTE_SUPPORT_ALARM,
            entity_type="device",
            entity_id=device.id,
            details={
                "hostname": device.hostname,
                "techi_remote_id": device.rustdesk_id,
                "reason": reason,
                "caller": caller,
                "caller_id": _text(info.get("id"), 64),
                "caller_ip": caller_ip,
            },
        )
        DeviceActivityEventService(self.db).record(
            device_id=device.id,
            event_type="remote_support_alarm",
            summary="Remote Support refused a connection",
            detail=detail,
            actor=caller or "unknown",
            fail_silently=True,
        )
        return True

    def _alarm_recorded_recently(self, device_id: int, detail: str) -> bool:
        since = utcnow() - ALARM_REPEAT_WINDOW
        return (
            self.db.query(DeviceActivityEvent.id)
            .filter(
                DeviceActivityEvent.device_id == device_id,
                DeviceActivityEvent.event_type == "remote_support_alarm",
                DeviceActivityEvent.detail == detail,
                DeviceActivityEvent.occurred_at >= since,
            )
            .first()
            is not None
        )

    def _reporting_device(self, rustdesk_id, source_ip: Optional[str]) -> Optional[Device]:
        valid, normalized, _ = RustDeskIdentityService.validate_rustdesk_id(str(rustdesk_id))
        if not valid:
            return None
        device = DeviceRepository(self.db).get_by_rustdesk_id(normalized)
        if device is None or device.is_archived:
            return None
        if not source_ip or (device.public_ip or "").strip() != source_ip:
            logger.info(
                "RustDesk report for device #%s ignored: sent from %s, the agent reports from %s",
                device.id,
                source_ip,
                device.public_ip,
            )
            return None
        return device

    @staticmethod
    def _session_details(connection: RemoteSupportConnection) -> dict:
        return {
            "source": "rustdesk",
            "peer_id": connection.peer_id,
            "peer_name": connection.peer_name,
            "connection_type": CONNECTION_TYPES.get(connection.conn_type, f"type {connection.conn_type}"),
            "rustdesk_session_id": connection.session_id,
        }
