import logging
import secrets
from app.core.time import utcnow
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.models.reenrollment_request import ReenrollmentRequest
from app.repositories.device_repository import DeviceRepository
from app.repositories.reenrollment_request_repository import ReenrollmentRequestRepository
from app.schemas.agent import AgentEnrollmentRequest, AgentEnrollmentResponse
from app.schemas.device import DeviceCreate, DeviceStatus, DeviceUpdate
from app.services.device_assignment_service import AssignmentSignal, DeviceAssignmentService
from app.services.device_activity_event_service import DeviceActivityEventService
from app.services.enrollment_audit_service import EnrollmentAuditService
from app.models.enrollment_token import EnrollmentTokenStatus
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.rustdesk_service import RustDeskIdentityService
from app.services.trusted_domain_service import TrustedDomainService
from app.services.audit_service import AuditAction, system_audit_log
from app.services.notification_events import NotificationEvent
from app.services.notification_service import NotificationService
from app.platform_core.registry import validate_architecture

logger = logging.getLogger(__name__)


class AgentEnrollmentService:
    def __init__(self, db: Session):
        self.db = db
        self.device_repo = DeviceRepository(db)
        self.token_service = EnrollmentTokenService(db)
        self.assignment_service = DeviceAssignmentService(db)
        self.activity_service = DeviceActivityEventService(db)
        self.enrollment_audit = EnrollmentAuditService(db)
        self.reenrollment_requests = ReenrollmentRequestRepository(db)

    def enroll(
        self,
        payload: AgentEnrollmentRequest,
        *,
        heartbeat_url: str,
        websocket_url: str,
    ) -> AgentEnrollmentResponse:
        # Registry-driven architecture validation. Only platforms that DECLARE
        # supported architectures (e.g. MikroTik) are checked; agent platforms
        # (Windows/Linux/macOS) declare none and pass through unchanged.
        try:
            validate_architecture(payload.platform, payload.architecture)
        except ValueError as exc:
            self._record_audit(
                payload=payload, result="failed",
                reason="unsupported_architecture", raw_error=str(exc),
            )
            raise

        # Trusted domain path — no token required
        domain = (payload.domain or "").strip()
        if not payload.enrollment_token and TrustedDomainService(self.db).is_trusted_domain(domain, payload.hostname):
            return self._enroll_trusted_domain(
                payload, domain=domain, heartbeat_url=heartbeat_url, websocket_url=websocket_url
            )

        if not payload.enrollment_token:
            # Name the cause when the domain is listed but the switch is off, so
            # the enrollment audit explains why a domain PC did not enroll.
            listed = TrustedDomainService(self.db).get_active_domain(domain) is not None
            self._record_audit(
                payload=payload,
                result="failed",
                reason="trusted_domain_auto_enrollment_disabled" if listed else "token_required",
                raw_error="enrollment_token is required",
            )
            raise ValueError("enrollment_token is required when trusted domain auto-enrollment is disabled or domain is not trusted")

        try:
            token = self.token_service.get_for_enrollment(payload.enrollment_token)
        except ValueError as exc:
            self._record_audit(
                payload=payload,
                result="failed",
                reason=f"token_{str(exc)}",
                raw_error=str(exc),
            )
            raise

        incoming_agent_id = self._normalize(payload.agent_id)
        agent_id = incoming_agent_id or self._new_agent_id()
        valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        identity_rustdesk_id = normalized_rustdesk_id if valid_rustdesk_id else None

        existing = self._find_existing_device(payload, rustdesk_id=identity_rustdesk_id)

        takeover = self._blocked_takeover(existing, incoming_agent_id, identity_rustdesk_id)
        if takeover is not None:
            return self._hold_for_review(
                payload, existing, incoming_agent_id, takeover,
                heartbeat_url=heartbeat_url, websocket_url=websocket_url,
                token=token, token_client_id=token.client_id,
            )

        # Token status is enforced only for first-time enrollments. An existing
        # device may re-enroll on an exhausted (USED) token because it does not
        # consume a use slot; revoked and expired tokens stay rejected for both.
        allowed_statuses = (
            (EnrollmentTokenStatus.ACTIVE, EnrollmentTokenStatus.USED)
            if existing is not None
            else (EnrollmentTokenStatus.ACTIVE,)
        )
        if token.status not in allowed_statuses:
            reason = token.status.value
            self._record_audit(
                payload=payload,
                token=token,
                result="failed",
                reason=f"token_{reason}",
                raw_error=reason,
            )
            raise ValueError(reason)

        device = None
        try:
            device = self._upsert_device(
                payload,
                agent_id=agent_id,
                rustdesk_id=identity_rustdesk_id,
                client_id=token.client_id,
                group_id=token.group_id,
                existing=existing,
            )
            reenrollment_matched = bool(getattr(device, "_reenrollment_matched", False))
            if not reenrollment_matched:
                device = self.assignment_service.apply_enrollment_assignment(
                    device,
                    client_id=token.client_id,
                    group_id=token.group_id,
                    signal=AssignmentSignal(
                        hostname=payload.hostname,
                        domain=domain or None,
                        public_ip=payload.public_ip,
                        os_name=payload.os_name,
                        os_version=payload.os_version,
                        os_caption=payload.os_caption,
                        os_build=payload.os_build,
                        windows_product_type=payload.windows_product_type,
                        platform=payload.platform,
                    ),
                )
            device = self.assignment_service.apply_resolution(device)
            # Token uses are consumed only by first-time enrollments; re-enrollments
            # of an existing device must not eat into max_uses.
            if not reenrollment_matched:
                self.token_service.mark_enrollment_used(token)
        except Exception as exc:
            self._record_audit(
                payload=payload,
                token=token,
                device=device,
                result="failed",
                reason="enrollment_processing_failed",
                raw_error=str(exc),
            )
            raise

        self._record_audit(
            payload=payload,
            token=token,
            device=device,
            result="updated_existing" if reenrollment_matched else "success",
            reason="reenrollment_match" if reenrollment_matched else "device_created",
        )

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

        existing = self._find_existing_device(payload, rustdesk_id=identity_rustdesk_id)
        takeover = self._blocked_takeover(existing, incoming_agent_id, identity_rustdesk_id)
        if takeover is not None:
            return self._hold_for_review(
                payload, existing, incoming_agent_id, takeover,
                heartbeat_url=heartbeat_url, websocket_url=websocket_url,
                token=None, token_client_id=None,
            )

        device = self._upsert_device(
            payload,
            agent_id=agent_id,
            rustdesk_id=identity_rustdesk_id,
            client_id=None,
            group_id=None,
            existing=existing,
        )
        if not getattr(device, "_reenrollment_matched", False):
            device = self.assignment_service.apply_trusted_domain_assignment(
                device,
                domain=domain,
                signal=AssignmentSignal(
                    hostname=payload.hostname,
                    domain=domain,
                    public_ip=payload.public_ip,
                    os_name=payload.os_name,
                    os_version=payload.os_version,
                    os_caption=payload.os_caption,
                    os_build=payload.os_build,
                    windows_product_type=payload.windows_product_type,
                    platform=payload.platform,
                ),
            )
        device = self.assignment_service.apply_resolution(device)
        system_audit_log(
            self.db,
            action=AuditAction.BOOTSTRAP_SCRIPT_SERVED,
            entity_type="device",
            entity_id=device.id,
            details={
                "kind": "trusted_domain_enrollment",
                "hostname": payload.hostname,
                "domain": domain,
                "client_id": device.client_id,
                "group_id": device.group_id,
            },
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

    def _find_existing_device(
        self,
        payload: AgentEnrollmentRequest,
        *,
        rustdesk_id: Optional[str],
    ) -> Optional[Device]:
        return self.device_repo.find_reenrollment_match(
            agent_id=self._normalize(payload.agent_id),
            rustdesk_id=rustdesk_id,
            hostname=self._normalize(payload.hostname),
            local_ip=self._normalize(payload.local_ip),
            public_ip=self._normalize(payload.public_ip),
        )

    def _blocked_takeover(
        self,
        existing: Optional[Device],
        incoming_agent_id: Optional[str],
        incoming_rustdesk_id: Optional[str] = None,
    ) -> Optional[str]:
        """Why this enrollment must not take `existing` over, or None when it may.

        A match is a takeover only when the device already carries a different
        agent_id: a reinstalled machine sends a fresh one, a clone sends its
        own, and either way the device must stay with the agent it has until an
        admin decides. A match on the device's own agent_id, or on a device
        that never had one, is the real agent and proceeds.
        """
        if existing is None:
            return None
        stored = (existing.agent_id or "").strip()
        incoming = (incoming_agent_id or "").strip()
        if not stored or stored == incoming:
            return None
        # The caller presents no agent_id: an agent that lost its config
        # re-enrolling. When its RustDesk id still matches the device, it is the
        # same machine — re-attach. Only a different, non-empty agent_id (a real
        # second machine, a clone) is a takeover to hold.
        if not incoming:
            if incoming_rustdesk_id and existing.rustdesk_id == incoming_rustdesk_id:
                return None
            return "fingerprint"
        if incoming_rustdesk_id and existing.rustdesk_id == incoming_rustdesk_id:
            return "rustdesk_id"
        return "fingerprint"

    def _hold_for_review(
        self,
        payload: AgentEnrollmentRequest,
        existing: Device,
        incoming_agent_id: Optional[str],
        matched_by: str,
        *,
        heartbeat_url: str,
        websocket_url: str,
        token,
        token_client_id: Optional[int],
    ) -> AgentEnrollmentResponse:
        """A matched device already belongs to another agent. Record the
        request for an admin instead of handing the device over, and enroll the
        caller as its own fresh device so it is visible and manageable but holds
        no other machine's identity."""
        now = utcnow()
        agent_id = incoming_agent_id or self._new_agent_id()
        valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        # A fresh device: never the matched one, and without the contested
        # rustdesk_id (the real device keeps it; the heartbeat resolves this one
        # by its own agent_id).
        created = self.device_repo.create(
            DeviceCreate(
                agent_id=agent_id,
                hostname=self._normalize(payload.hostname),
                current_user=self._normalize(payload.current_user),
                domain=self._normalize(payload.domain),
                public_ip=self._normalize(payload.public_ip),
                local_ip=self._normalize(payload.local_ip),
                os_name=self._normalize(payload.os_name),
                os_version=self._normalize(payload.os_version),
                os_caption=self._normalize(payload.os_caption),
                os_build=self._normalize(payload.os_build),
                windows_product_type=payload.windows_product_type,
                platform=self._normalize(payload.platform),
                architecture=self._normalize(payload.architecture),
                cpu=None,
                ram=None,
                storage=None,
                client_id=token_client_id,
                group_id=token.group_id if token else None,
                auto_assigned=False,
                assignment_source="enrollment_token" if token_client_id else "system_auto",
                status=DeviceStatus.OFFLINE,
                rustdesk_id=None,
                rustdesk_sync_state="pending",
                rustdesk_sync_message="Awaiting first heartbeat",
                last_seen=now,
                last_enrollment_at=now,
                duplicate_candidate=True,
                duplicate_of_device_id=existing.id,
            )
        )
        existing_request = self.reenrollment_requests.for_device_agent(existing.id, agent_id)
        if existing_request is None:
            self.reenrollment_requests.add(
                ReenrollmentRequest(
                    device_id=existing.id,
                    agent_id=agent_id,
                    matched_by=matched_by,
                    status="pending",
                    hostname=self._normalize(payload.hostname),
                    current_user=self._normalize(payload.current_user),
                    domain=self._normalize(payload.domain),
                    local_ip=self._normalize(payload.local_ip),
                    public_ip=self._normalize(payload.public_ip),
                    rustdesk_id=normalized_rustdesk_id if valid_rustdesk_id else None,
                    os_caption=self._normalize(payload.os_caption),
                    platform=self._normalize(payload.platform),
                    token_name=getattr(token, "name", None),
                    new_device_id=created.id,
                    last_seen_at=now.replace(tzinfo=None),
                )
            )
            self.db.commit()
        self.activity_service.record(
            device_id=existing.id,
            event_type="reenrollment_held",
            summary="Re-enrollment held for review",
            detail=f"Another agent (host {self._normalize(payload.hostname) or 'unknown'}) matched this device "
            f"by {matched_by} but did not prove its identity; enrolled as device #{created.id}.",
            actor="agent",
            fail_silently=True,
        )
        self._record_audit(
            payload=payload, token=token, device=existing,
            result="held_for_review", reason=f"takeover_blocked_{matched_by}",
        )
        return AgentEnrollmentResponse(
            agent_id=agent_id,
            device_id=created.id,
            heartbeat_url=heartbeat_url,
            websocket_url=websocket_url,
            enrollment_status="enrolled",
            assigned_client_id=token_client_id,
            assigned_group_id=token.group_id if token else None,
        )

    def _upsert_device(
        self,
        payload: AgentEnrollmentRequest,
        *,
        agent_id: str,
        rustdesk_id: Optional[str],
        client_id: Optional[int],
        group_id: Optional[int],
        existing: Optional[Device],
    ) -> Device:
        now = utcnow()
        previous_agent_id = existing.agent_id if existing else None
        data = {
            "agent_id": agent_id,
            "hostname": self._normalize(payload.hostname),
            "current_user": self._normalize(payload.current_user),
            "domain": self._normalize(payload.domain),
            "public_ip": self._normalize(payload.public_ip),
            "local_ip": self._normalize(payload.local_ip),
            "os_name": self._normalize(payload.os_name),
            "os_version": self._normalize(payload.os_version),
            "os_caption": self._normalize(payload.os_caption),
            "os_build": self._normalize(payload.os_build),
            "windows_product_type": payload.windows_product_type,
            "platform": self._normalize(payload.platform),
            "architecture": self._normalize(payload.architecture),
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

    def _record_audit(self, **values) -> None:
        try:
            self.enrollment_audit.record(**values)
        except Exception:
            logger.exception("Enrollment audit failed outside best-effort service boundary")
        if values.get("result") == "failed":
            self._notify_enrollment_failed(**values)

    def _notify_enrollment_failed(self, **values) -> None:
        try:
            payload = values.get("payload")
            token = values.get("token")
            hostname = getattr(payload, "hostname", None) or "unknown device"
            reason = values.get("reason") or "enrollment_failed"
            NotificationService(self.db).dispatch(
                event_type=NotificationEvent.ENROLLMENT_FAILED,
                title=f"Enrollment failed: {hostname}",
                message=f"Enrollment attempt for {hostname} failed ({reason}).",
                severity="warning",
                client_id=getattr(token, "client_id", None),
                payload={"reason": reason, "hostname": hostname},
            )
        except Exception:
            logger.exception("Enrollment-failed notification dispatch failed")

    @staticmethod
    def _normalize(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None
