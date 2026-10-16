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

from app.core.time import utcnow_naive
from app.models.device import Device
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
            RemoteSessionService(self.db).apply_report(device, True, details=self._session_details(connection))
            return True

        if report.action == "close":
            connection = self.connections.latest_open(device.id, report.conn_id)
            if connection is None:
                return False
            connection.closed_at = now
            self.db.commit()
            if connection.authorized_at is not None and not self.connections.count_open_authorized(
                device.id, since=now - OPEN_CONNECTION_LIMIT
            ):
                RemoteSessionService(self.db).apply_report(device, False, details=self._session_details(connection))
            return True

        return False

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
            detail=" · ".join(part for part in (reason, caller, caller_ip) if part),
            actor=caller or "unknown",
            fail_silently=True,
        )
        return True

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
