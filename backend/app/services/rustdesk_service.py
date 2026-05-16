import re
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import (
    RustDeskHealth,
    RustDeskIdVerifyResponse,
)
from app.websocket.events import RealtimeEventType, build_event, device_payload
from app.websocket.publisher import realtime_publisher


RUSTDESK_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
GENERATED_AGENT_ID_PATTERN = re.compile(r"^agent_[A-Za-z0-9_-]+$")
PENDING_RUSTDESK_ID_PATTERN = re.compile(r"^pending_[A-Za-z0-9_-]+$")
PLACEHOLDER_IDS = {"rustdesk-placeholder", "unknown", "unset", "none"}


class RustDeskIdentityService:
    def __init__(self, db: Session):
        self.db = db
        self.device_repo = DeviceRepository(db)

    @staticmethod
    def normalize_rustdesk_id(rustdesk_id: str) -> str:
        return rustdesk_id.strip()

    @classmethod
    def validate_rustdesk_id(cls, rustdesk_id: Optional[str]) -> tuple[bool, str, Optional[str]]:
        normalized = cls.normalize_rustdesk_id(rustdesk_id or "")
        if not normalized:
            return False, normalized, "RustDesk ID is required"
        if normalized.lower() in PLACEHOLDER_IDS:
            return False, normalized, "RustDesk ID is still a placeholder"
        if GENERATED_AGENT_ID_PATTERN.match(normalized.lower()):
            return False, normalized, "RustDesk ID is not discovered yet"
        if PENDING_RUSTDESK_ID_PATTERN.match(normalized.lower()):
            return False, normalized, "RustDesk ID is pending discovery"
        if not RUSTDESK_ID_PATTERN.match(normalized):
            return False, normalized, "RustDesk ID must be 6-64 characters and contain only letters, numbers, underscore, or dash"
        return True, normalized, None

    def verify(self, rustdesk_id: str, *, exclude_device_id: Optional[int] = None) -> RustDeskIdVerifyResponse:
        valid, normalized, message = self.validate_rustdesk_id(rustdesk_id)
        if not valid:
            return RustDeskIdVerifyResponse(valid=False, normalized_rustdesk_id=normalized, message=message)

        conflict = self.device_repo.get_conflicting_rustdesk_id(normalized, exclude_device_id=exclude_device_id)
        if conflict:
            return RustDeskIdVerifyResponse(
                valid=False,
                normalized_rustdesk_id=normalized,
                message="RustDesk ID is already bound to another device",
                conflict_device_id=conflict.id,
            )

        return RustDeskIdVerifyResponse(valid=True, normalized_rustdesk_id=normalized, message="RustDesk ID is available")

    def apply_heartbeat_sync(
        self,
        device: Device,
        *,
        reported_rustdesk_id: Optional[str],
        install_status: Optional[str],
        rustdesk_status: Optional[str],
        version: Optional[str],
        install_path: Optional[str],
        hostname: Optional[str] = None,
        local_ip: Optional[str] = None,
        public_ip: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> Device:
        now = now or datetime.utcnow()
        previous_status = device.rustdesk_status
        device.rustdesk_install_status = install_status or "unknown"
        device.rustdesk_status = rustdesk_status or "unknown"
        device.rustdesk_version = version
        device.rustdesk_install_path = install_path

        effective_id = (reported_rustdesk_id or "").strip()

        if effective_id:
            return self._sync_from_agent_id(
                device, effective_id=effective_id, previous_status=previous_status, now=now
            )

        return self._sync_via_resolver(
            device,
            hostname=hostname,
            local_ip=local_ip,
            public_ip=public_ip,
            previous_status=previous_status,
            now=now,
        )

    def _sync_from_agent_id(
        self,
        device: Device,
        *,
        effective_id: str,
        previous_status: Optional[str],
        now: datetime,
    ) -> Device:
        verification = self.verify(effective_id, exclude_device_id=device.id)

        if not verification.valid:
            device.rustdesk_conflict_detected = verification.conflict_device_id is not None
            device.rustdesk_sync_state = "failed"
            device.rustdesk_sync_message = verification.message
            self.db.add(device)
            self.db.commit()
            self.db.refresh(device)
            self._publish(RealtimeEventType.SYNC_FAILED, device, "rustdesk_sync_failed")
            return device

        normalized = verification.normalized_rustdesk_id or effective_id
        if not device.rustdesk_manual_override and device.rustdesk_id != normalized:
            device.rustdesk_id = normalized

        device.rustdesk_last_seen_at = now
        device.rustdesk_synced_at = now
        device.rustdesk_verified_at = now
        device.rustdesk_sync_state = "synced"
        device.rustdesk_sync_message = None
        device.rustdesk_conflict_detected = False

        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)

        self._publish(RealtimeEventType.RUSTDESK_UPDATED, device, "rustdesk_heartbeat_sync")
        self._maybe_publish_status_change(device, previous_status)
        return device

    def _sync_via_resolver(
        self,
        device: Device,
        *,
        hostname: Optional[str],
        local_ip: Optional[str],
        public_ip: Optional[str],
        previous_status: Optional[str],
        now: datetime,
    ) -> Device:
        from app.services.rustdesk_resolver_service import RustDeskResolverService

        result = RustDeskResolverService.resolve(
            hostname=hostname, local_ip=local_ip, public_ip=public_ip
        )

        if result.confidence == "high" and result.rustdesk_id:
            conflict = self.device_repo.get_conflicting_rustdesk_id(
                result.rustdesk_id, exclude_device_id=device.id
            )
            if conflict is None and not device.rustdesk_manual_override:
                device.rustdesk_id = result.rustdesk_id
                device.rustdesk_verified_at = now
            device.rustdesk_last_seen_at = now
            device.rustdesk_synced_at = now
            device.rustdesk_sync_state = "synced"
            device.rustdesk_sync_message = result.message
            device.rustdesk_conflict_detected = False

            self.db.add(device)
            self.db.commit()
            self.db.refresh(device)
            self._publish(RealtimeEventType.RUSTDESK_UPDATED, device, "rustdesk_resolver_synced")
            self._maybe_publish_status_change(device, previous_status)

        elif result.confidence in ("medium", "low"):
            # Ambiguous or stale match — do not touch rustdesk_id
            sync_state = "degraded"
            device.rustdesk_sync_state = sync_state
            device.rustdesk_sync_message = result.message
            device.rustdesk_conflict_detected = False

            self.db.add(device)
            self.db.commit()
            self.db.refresh(device)
            self._publish(RealtimeEventType.SYNC_FAILED, device, "rustdesk_resolver_degraded")

        else:
            device.rustdesk_sync_state = "failed"
            device.rustdesk_sync_message = result.message or "RustDesk ID not resolved yet"
            device.rustdesk_conflict_detected = False

            self.db.add(device)
            self.db.commit()
            self.db.refresh(device)
            self._publish(RealtimeEventType.SYNC_FAILED, device, "rustdesk_id_unresolved")

        return device

    def _maybe_publish_status_change(self, device: Device, previous_status: Optional[str]) -> None:
        if previous_status == device.rustdesk_status:
            return
        if device.rustdesk_status == "running":
            self._publish(RealtimeEventType.RUSTDESK_ONLINE, device, "rustdesk_status_running")
        elif device.rustdesk_status in {"stopped", "not_running", "not_installed"}:
            self._publish(RealtimeEventType.RUSTDESK_OFFLINE, device, "rustdesk_status_offline")

    def manual_override(self, device: Device, rustdesk_id: str, *, reason: Optional[str] = None) -> Device:
        verification = self.verify(rustdesk_id, exclude_device_id=device.id)
        if not verification.valid:
            raise ValueError(verification.message or "Invalid RustDesk ID")

        device.rustdesk_id = verification.normalized_rustdesk_id or rustdesk_id
        device.rustdesk_manual_override = True
        device.rustdesk_sync_state = "manual_override"
        device.rustdesk_sync_message = reason
        device.rustdesk_verified_at = datetime.utcnow()
        device.rustdesk_conflict_detected = False
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)
        self._publish(RealtimeEventType.RUSTDESK_UPDATED, device, "rustdesk_manual_override")
        return device

    @staticmethod
    def health(device: Device) -> RustDeskHealth:
        return RustDeskHealth(
            device_id=device.id,
            rustdesk_id=device.rustdesk_id,
            install_status=device.rustdesk_install_status,
            status=device.rustdesk_status,
            version=device.rustdesk_version,
            install_path=device.rustdesk_install_path,
            sync_state=device.rustdesk_sync_state,
            sync_message=device.rustdesk_sync_message,
            last_update=device.rustdesk_last_seen_at,
            verified_at=device.rustdesk_verified_at,
            manual_override=device.rustdesk_manual_override,
            conflict_detected=device.rustdesk_conflict_detected,
        )

    @staticmethod
    def _publish(event_type: RealtimeEventType, device: Device, reason: str) -> None:
        realtime_publisher.publish_threadsafe(
            build_event(event_type, data=device_payload(device), reason=reason),
            dedupe_key=f"{event_type.value}:{device.id}:{device.rustdesk_status}:{device.rustdesk_sync_state}",
        )
