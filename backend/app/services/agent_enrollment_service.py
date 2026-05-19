import logging
import secrets
from datetime import datetime
from app.core.time import utcnow
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import AgentEnrollmentRequest, AgentEnrollmentResponse
from app.schemas.device import DeviceCreate, DeviceStatus, DeviceUpdate
from app.services.device_assignment_service import AssignmentSignal, DeviceAssignmentService
from app.services.device_activity_event_service import DeviceActivityEventService
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.rustdesk_service import RustDeskIdentityService
from app.services.trusted_domain_service import TrustedDomainService

logger = logging.getLogger(__name__)


class AgentEnrollmentService:
    def __init__(self, db: Session):
        self.db = db
        self.device_repo = DeviceRepository(db)
        self.token_service = EnrollmentTokenService(db)
        self.assignment_service = DeviceAssignmentService(db)
        self.activity_service = DeviceActivityEventService(db)

    def enroll(
        self,
        payload: AgentEnrollmentRequest,
        *,
        heartbeat_url: str,
        websocket_url: str,
    ) -> AgentEnrollmentResponse:
        # Trusted domain path — no token required
        domain = (payload.domain or "").strip()
        if not payload.enrollment_token and TrustedDomainService.is_trusted(domain, payload.hostname):
            return self._enroll_trusted_domain(
                payload, domain=domain, heartbeat_url=heartbeat_url, websocket_url=websocket_url
            )

        if not payload.enrollment_token:
            raise ValueError("enrollment_token is required when trusted domain auto-enrollment is disabled or domain is not trusted")

        token = self.token_service.validate_for_enrollment(payload.enrollment_token)
        incoming_agent_id = self._normalize(payload.agent_id)
        agent_id = incoming_agent_id or self._new_agent_id()
        valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        identity_rustdesk_id = normalized_rustdesk_id if valid_rustdesk_id else None

        device = self._upsert_device(
            payload,
            agent_id=agent_id,
            rustdesk_id=identity_rustdesk_id,
            client_id=token.client_id,
            group_id=token.group_id,
        )
        if not getattr(device, "_reenrollment_matched", False):
            device = self.assignment_service.apply_enrollment_assignment(
                device,
                client_id=token.client_id,
                group_id=token.group_id,
                signal=AssignmentSignal(
                    hostname=payload.hostname,
                    domain=domain or None,
                    public_ip=payload.public_ip,
                    os_name=payload.os_name,
                    platform=payload.platform,
                ),
            )
        device = self.assignment_service.apply_resolution(device)
        self.token_service.mark_enrollment_used(token)

        return AgentEnrollmentResponse(
            agent_id=agent_id,
            device_id=device.id,
            heartbeat_url=heartbeat_url,
            websocket_url=websocket_url,
            enrollment_status="enrolled",
            assigned_client_id=token.client_id,
            assigned_group_id=token.group_id,
        )

    def _enroll_trusted_domain(
        self,
        payload: AgentEnrollmentRequest,
        *,
        domain: str,
        heartbeat_url: str,
        websocket_url: str,
    ) -> AgentEnrollmentResponse:
        logger.info(
            "[trusted_domain] auto-enrolling hostname=%s domain=%s",
            payload.hostname, domain,
        )
        incoming_agent_id = self._normalize(payload.agent_id)
        agent_id = incoming_agent_id or self._new_agent_id()
        valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        identity_rustdesk_id = normalized_rustdesk_id if valid_rustdesk_id else None

        device = self._upsert_device(payload, agent_id=agent_id, rustdesk_id=identity_rustdesk_id, client_id=None, group_id=None)
        if not getattr(device, "_reenrollment_matched", False):
            device = self.assignment_service.apply_trusted_domain_assignment(
                device,
                domain=domain,
                signal=AssignmentSignal(
                    hostname=payload.hostname,
                    domain=domain,
                    public_ip=payload.public_ip,
                    os_name=payload.os_name,
                    platform=payload.platform,
                ),
            )

        return AgentEnrollmentResponse(
            agent_id=agent_id,
            device_id=device.id,
            heartbeat_url=heartbeat_url,
            websocket_url=websocket_url,
            enrollment_status="enrolled_trusted_domain",
            assigned_client_id=device.client_id,
            assigned_group_id=device.group_id,
        )

    def _upsert_device(
        self,
        payload: AgentEnrollmentRequest,
        *,
        agent_id: str,
        rustdesk_id: Optional[str],
        client_id: Optional[int],
        group_id: Optional[int],
    ) -> Device:
        now = utcnow()
        existing = self.device_repo.find_reenrollment_match(
            agent_id=self._normalize(payload.agent_id),
            rustdesk_id=rustdesk_id,
            hostname=self._normalize(payload.hostname),
            local_ip=self._normalize(payload.local_ip),
            public_ip=self._normalize(payload.public_ip),
        )
        previous_agent_id = existing.agent_id if existing else None
        data = {
            "agent_id": agent_id,
            "hostname": self._normalize(payload.hostname),
            "current_user": self._normalize(payload.current_user),
            "domain": None,
            "public_ip": self._normalize(payload.public_ip),
            "local_ip": self._normalize(payload.local_ip),
            "os_name": self._normalize(payload.os_name),
            "os_version": self._normalize(payload.os_version),
            "platform": self._normalize(payload.platform),
            "cpu": None,
            "ram": None,
            "storage": None,
            "client_id": client_id,
            "group_id": group_id,
            "auto_assigned": False,
            "assignment_source": "enrollment_token" if client_id or group_id else "system_auto",
            "status": DeviceStatus.OFFLINE,
            "rustdesk_install_status": "unknown",
            "rustdesk_status": "unknown",
            "rustdesk_version": None,
            "rustdesk_install_path": None,
            "rustdesk_last_seen_at": None,
            "rustdesk_synced_at": None,
            "rustdesk_sync_state": "pending",
            "rustdesk_sync_message": "Awaiting first heartbeat",
            "rustdesk_verified_at": None,
            "rustdesk_manual_override": False,
            "rustdesk_conflict_detected": False,
            "last_enrollment_at": now,
        }

        if existing:
            update_data = {key: value for key, value in data.items() if value is not None}
            if (existing.assignment_source or "").strip().lower() in {
                DeviceAssignmentService.MANUAL_SOURCE,
                DeviceAssignmentService.LEGACY_MANUAL_SOURCE,
                DeviceAssignmentService.TRUSTED_DOMAIN_SOURCE,
                DeviceAssignmentService.ENROLLMENT_SOURCE,
            }:
                for field in ("client_id", "group_id", "assignment_source", "auto_assigned"):
                    update_data.pop(field, None)
            update_data["enrollment_count"] = (existing.enrollment_count or 0) + 1
            if previous_agent_id and previous_agent_id != agent_id:
                update_data["reenrolled_from_agent_id"] = previous_agent_id
            updated = self.device_repo.update(existing, DeviceUpdate(**update_data))
            self.activity_service.record(
                device_id=updated.id,
                event_type="device_reenrolled",
                summary="Device re-enrolled",
                detail=f"Reconciled enrollment to existing device. Previous agent_id={previous_agent_id or 'none'}",
                actor="agent",
                fail_silently=True,
            )
            setattr(updated, "_reenrollment_matched", True)
            return updated

        created = self.device_repo.create(
            DeviceCreate(
                rustdesk_id=rustdesk_id,
                last_seen=now,
                enrollment_count=1,
                **data,
            )
        )
        setattr(created, "_reenrollment_matched", False)
        return created

    @staticmethod
    def _new_agent_id() -> str:
        return f"agent_{secrets.token_urlsafe(18)}"

    @staticmethod
    def _normalize(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None
