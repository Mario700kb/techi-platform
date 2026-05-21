import logging
from datetime import datetime, timedelta
from app.core.time import utcnow
from typing import Optional

from app.models.device import Device, DeviceStatus, DeviceType
from app.repositories.device_repository import DeviceRepository
from app.repositories.device_heartbeat_repository import DeviceHeartbeatRepository
from app.schemas.agent import AgentHeartbeatPayload, DeviceHeartbeatCreate
from app.schemas.device import DeviceCreate, DeviceUpdate
from app.services.alert_engine import AlertEngine
from app.services.alert_rules import RECONNECT_WINDOW_SECONDS
from app.services.device_assignment_service import AssignmentSignal, DeviceAssignmentService
from app.services.device_fingerprint_service import DeviceFingerprintService, FingerprintMatch
from app.services.device_health_score_service import DeviceHealthScoreService
from app.services.device_inventory_service import DeviceInventoryService
from app.services.device_maintenance_service import DeviceMaintenanceService, is_maintenance_active
from app.services.device_status_service import DeviceStatusService
from app.services.device_telemetry_service import DeviceTelemetryService
from app.services.device_activity_event_service import DeviceActivityEventService
from app.services.rustdesk_service import RustDeskIdentityService
from app.websocket.events import RealtimeEventType, build_event, device_payload
from app.websocket.publisher import realtime_publisher

logger = logging.getLogger(__name__)

# Active devices seen within this window are protected from automatic reuse
# when they have a different rustdesk_id (prevents false merge of live machines).
_RECENTLY_SEEN_HOURS = 24


class DeviceHeartbeatService:
    def __init__(self, db):
        self.db = db
        self.device_repo = DeviceRepository(db)
        self.heartbeat_repo = DeviceHeartbeatRepository(db)
        self.assignment_service = DeviceAssignmentService(db)
        self.status_service = DeviceStatusService(db)
        self.rustdesk_service = RustDeskIdentityService(db)
        self.fingerprint_service = DeviceFingerprintService(db)
        self.maintenance_service = DeviceMaintenanceService(db)

    @staticmethod
    def classify_device_type(
        os_name: Optional[str],
        domain: Optional[str],
        *,
        os_version: Optional[str] = None,
        os_caption: Optional[str] = None,
        os_build: Optional[str] = None,
        windows_product_type: Optional[int] = None,
    ) -> DeviceType:
        if not domain or domain.strip().upper() == "WORKGROUP":
            return DeviceType.UNASSIGNED

        if windows_product_type in {2, 3}:
            return DeviceType.SERVER
        if windows_product_type == 1:
            return DeviceType.CLIENT

        normalized = " ".join(
            value.strip().lower()
            for value in (os_name, os_version, os_caption, os_build)
            if value and value.strip()
        )
        if "windows server" in normalized or "server" in normalized:
            return DeviceType.SERVER
        if "windows 10" in normalized or "windows 11" in normalized:
            return DeviceType.CLIENT

        return DeviceType.UNASSIGNED

    def process_heartbeat(self, payload: AgentHeartbeatPayload):
        device_type = self.classify_device_type(
            payload.os_name,
            payload.domain,
            os_version=payload.os_version,
            os_caption=payload.os_caption,
            os_build=payload.os_build,
            windows_product_type=payload.windows_product_type,
        )
        now = utcnow()
        has_valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )

        device = self.device_repo.get_by_agent_id(payload.agent_id) if payload.agent_id else None
        if device is None:
            device = self.device_repo.get(payload.device_id) if payload.device_id else None
        if device is None and has_valid_rustdesk_id:
            device = self.device_repo.get_by_rustdesk_id(normalized_rustdesk_id)
        if device is not None:
            device = self.maintenance_service.expire_if_needed(device)
        previous_payload = device_payload(device) if device else None
        prev_user = device.current_user if device else None
        prev_repair_count = device.rustdesk_repair_count if device else 0
        if device:
            update_data = payload.model_dump(exclude_unset=True, exclude={"device_id", "rustdesk_id"})
            for field in ("rustdesk_install_status", "rustdesk_status", "rustdesk_version", "rustdesk_install_path"):
                update_data.pop(field, None)
            if has_valid_rustdesk_id and normalized_rustdesk_id != device.rustdesk_id:
                conflict = self.device_repo.get_conflicting_rustdesk_id(normalized_rustdesk_id, exclude_device_id=device.id)
                if conflict is None:
                    update_data["rustdesk_id"] = normalized_rustdesk_id
            if device.assignment_source in {
                DeviceAssignmentService.MANUAL_SOURCE,
                DeviceAssignmentService.ENROLLMENT_SOURCE,
            }:
                for field in ("client_id", "group_id", "assignment_source", "auto_assigned"):
                    update_data.pop(field, None)
            update_data["device_type"] = device_type
            # If device_type changed (e.g. CLIENT → SERVER), allow re-grouping
            if device.device_type != device_type and device_type in (DeviceType.SERVER, DeviceType.CLIENT):
                update_data.pop("client_id", None)
                update_data.pop("group_id", None)
                update_data.pop("assignment_source", None)
                update_data.pop("auto_assigned", None)
                # Clear enrollment lock so reconcile can re-assign
                device.assignment_source = DeviceAssignmentService.TRUSTED_DOMAIN_SOURCE
            update_data["last_seen"] = now
            device = self.device_repo.update(device, DeviceUpdate(**update_data))
        else:
            device = self._resolve_via_fingerprint(payload, device_type, now)

        device = self.status_service.mark_online_from_heartbeat(device)
        device = self.rustdesk_service.apply_heartbeat_sync(
            device,
            reported_rustdesk_id=payload.rustdesk_id,
            install_status=payload.rustdesk_install_status,
            rustdesk_status=payload.rustdesk_status,
            version=payload.rustdesk_version,
            install_path=payload.rustdesk_install_path,
            hostname=payload.hostname,
            local_ip=payload.local_ip,
            public_ip=payload.public_ip,
            now=now,
        )

        before_assignment = (device.client_id, device.group_id, device.assignment_source)
        device = self.assignment_service.reconcile_trusted_domain_assignment(
            device,
            signal=AssignmentSignal(
                hostname=payload.hostname,
                domain=payload.domain,
                public_ip=payload.public_ip,
                os_name=payload.os_name,
                os_version=payload.os_version,
                os_caption=payload.os_caption,
                os_build=payload.os_build,
                windows_product_type=payload.windows_product_type,
                platform=payload.platform,
                device_type=device.device_type,
            ),
        )
        if before_assignment != (device.client_id, device.group_id, device.assignment_source):
            DeviceActivityEventService(self.db).record(
                device_id=device.id,
                event_type="device_regrouped",
                summary="Device regrouped",
                detail=f"Trusted-domain classification changed: {self._classification_reason(payload)}",
                actor="agent",
                fail_silently=True,
            )

        device = self.assignment_service.apply_resolution(device)

        heartbeat_data = DeviceHeartbeatCreate(
            device_id=device.id,
            rustdesk_id=device.rustdesk_id,
            hostname=device.hostname,
            current_user=device.current_user,
            domain=device.domain,
            public_ip=device.public_ip,
            local_ip=device.local_ip,
            os_name=device.os_name,
            os_version=device.os_version,
            os_caption=device.os_caption,
            os_build=device.os_build,
            windows_product_type=device.windows_product_type,
            platform=device.platform,
            device_type=device.device_type,
            status=device.status,
            cpu=device.cpu,
            ram=device.ram,
            storage=device.storage,
            rustdesk_install_status=device.rustdesk_install_status,
            rustdesk_status=device.rustdesk_status,
            rustdesk_version=device.rustdesk_version,
            rustdesk_install_path=device.rustdesk_install_path,
        )
        heartbeat = self.heartbeat_repo.create(heartbeat_data)
        current_payload = device_payload(device)
        realtime_publisher.publish_threadsafe(
            build_event(
                RealtimeEventType.HEARTBEAT_RECEIVED,
                data={**current_payload, "heartbeat_id": heartbeat.id},
                reason="heartbeat_received",
            )
        )
        if previous_payload is None or self._has_inventory_change(previous_payload, current_payload):
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.DEVICE_UPDATED,
                    data=current_payload,
                    reason="heartbeat_inventory_changed",
                ),
                dedupe_key=f"device_updated:{device.id}:inventory",
            )

        self._maybe_emit_user_changed(device, prev_user)
        self._maybe_emit_rustdesk_repaired(device, prev_repair_count)
        self._process_telemetry(payload, device)
        self._process_inventory(payload, device)
        self._evaluate_post_heartbeat_alerts(device)
        return device, heartbeat

    def _resolve_via_fingerprint(
        self, payload: AgentHeartbeatPayload, device_type: DeviceType, now: datetime
    ) -> Device:
        """
        When no device is found by device_id or rustdesk_id, use fingerprint scoring
        to decide whether to reuse an existing device or create a fresh record.

        Confidence rules (after safety gate):
          HIGH   (>=0.90) + archived match          → reuse existing archived record
          HIGH   (>=0.90) + active, not recent      → reuse existing active record
          HIGH   (>=0.90) + active, recently seen,
                            different rustdesk_id   → BLOCKED: create new + mark candidate
          MEDIUM (0.70–0.89)                        → create new + mark duplicate_candidate
          NONE   (<0.70)                            → create fresh device normally
        """
        has_valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        fingerprint_rustdesk_id = normalized_rustdesk_id if has_valid_rustdesk_id else None
        fingerprint_data = {
            "rustdesk_id": fingerprint_rustdesk_id,
            "hostname": payload.hostname,
            "local_ip": payload.local_ip,
            "public_ip": payload.public_ip,
            "current_user": payload.current_user,
            "domain": payload.domain,
            "os_name": payload.os_name,
            "os_caption": payload.os_caption,
            "os_build": payload.os_build,
            "windows_product_type": payload.windows_product_type,
            "platform": payload.platform,
            "cpu": payload.cpu,
            "ram": payload.ram,
            "storage": payload.storage,
        }

        match = self.fingerprint_service.find_best_match(
            fingerprint_data, exclude_rustdesk_id=fingerprint_rustdesk_id
        )

        effective_match = self._apply_safety_gate(match, payload, now)

        if effective_match.confidence == "high" and effective_match.device is not None:
            return self._reuse_device(effective_match.device, payload, device_type, now)

        create_data = payload.model_dump(exclude_unset=True, exclude={"agent_id", "device_id", "rustdesk_id"})
        create_data["agent_id"] = payload.agent_id
        create_data["rustdesk_id"] = fingerprint_rustdesk_id  # None when agent has no numeric RustDesk ID yet
        create_data["device_type"] = device_type
        create_data["status"] = DeviceStatus.OFFLINE
        create_data["last_seen"] = now
        create_data["auto_assigned"] = False
        create_data["assignment_source"] = "system_auto"

        if (
            effective_match.confidence == "medium"
            and effective_match.device is not None
            and not is_maintenance_active(effective_match.device)
        ):
            create_data["duplicate_candidate"] = True
            create_data["duplicate_of_device_id"] = effective_match.device.id
            create_data["duplicate_score"] = round(effective_match.score, 4)
            logger.info(
                "[fingerprint] duplicate candidate: new device rustdesk_id=%s flagged against device #%d (score=%.2f)",
                payload.rustdesk_id,
                effective_match.device.id,
                effective_match.score,
            )
        else:
            create_data["duplicate_candidate"] = False
            create_data["duplicate_of_device_id"] = None
            create_data["duplicate_score"] = None

        return self.device_repo.create(DeviceCreate(**create_data))

    @staticmethod
    def _classification_reason(payload: AgentHeartbeatPayload) -> str:
        if payload.windows_product_type in {1, 2, 3}:
            return f"windows_product_type={payload.windows_product_type}"
        for value in (payload.os_caption, payload.os_version, payload.os_name):
            if value and "windows server" in value.lower():
                return "os_caption_contains_server"
        return "default"

    def _apply_safety_gate(
        self,
        match: FingerprintMatch,
        payload: AgentHeartbeatPayload,
        now: datetime,
    ) -> FingerprintMatch:
        """
        Enforce the active+recent+different-rustdesk_id safety rule.

        If a HIGH-confidence match points to an ACTIVE device that:
          - has a different rustdesk_id than the incoming payload, AND
          - was seen within the last 24 h

        ...then automatic reuse is blocked. The match is downgraded to MEDIUM so
        a duplicate_candidate record is created instead. Archived devices are exempt
        from this gate because they cannot conflict with a live machine.
        """
        if match.confidence != "high" or match.device is None:
            return match

        existing = match.device
        has_valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        incoming_rustdesk_id = normalized_rustdesk_id if has_valid_rustdesk_id else None
        different_id = incoming_rustdesk_id is not None and existing.rustdesk_id != incoming_rustdesk_id
        is_active = not existing.is_archived
        recently_seen = (
            existing.last_seen is not None
            and (now - existing.last_seen) < timedelta(hours=_RECENTLY_SEEN_HOURS)
        )

        if is_active and different_id and recently_seen:
            logger.warning(
                "[fingerprint] safety block: active+recent device #%d (last_seen=%s) matched "
                "incoming rustdesk_id=%s (score=%.2f) — forcing duplicate_candidate, not reusing",
                existing.id,
                existing.last_seen.isoformat() if existing.last_seen else "never",
                payload.rustdesk_id,
                match.score,
            )
            return FingerprintMatch(device=existing, score=match.score, confidence="medium")

        return match

    def _reuse_device(
        self, existing: Device, payload: AgentHeartbeatPayload, device_type: DeviceType, now: datetime
    ) -> Device:
        """
        Update an existing device record with incoming heartbeat metadata.

        Invariants guaranteed by this method:
          - Manual or enrollment-token assignment (client_id, group_id, assignment_source,
            auto_assigned) is NEVER overwritten.
          - Archived state (is_archived, archived_at, archived_by) is NEVER overwritten —
            lifecycle transitions must be performed by a human operator.
          - rustdesk_id is updated only when no other live device already holds that ID.
          - duplicate_candidate is cleared on the reused device (now positively identified).
        """
        update_data = payload.model_dump(
            exclude_unset=True,
            exclude={"device_id", "rustdesk_id"},
        )

        # Rustdesk runtime fields are synced separately by apply_heartbeat_sync
        for field in ("rustdesk_install_status", "rustdesk_status", "rustdesk_version", "rustdesk_install_path"):
            update_data.pop(field, None)

        # Archived state must never be touched by duplicate logic
        for field in ("is_archived", "archived_at", "archived_by"):
            update_data.pop(field, None)

        # Attempt rustdesk_id update only when no other device already holds that ID
        has_valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        if has_valid_rustdesk_id and normalized_rustdesk_id != existing.rustdesk_id:
            conflict = self.device_repo.get_conflicting_rustdesk_id(
                normalized_rustdesk_id, exclude_device_id=existing.id
            )
            if conflict is None:
                update_data["rustdesk_id"] = normalized_rustdesk_id

        # Preserve manual / enrollment-token assignment — never override on reuse
        if existing.assignment_source in {
            DeviceAssignmentService.MANUAL_SOURCE,
            DeviceAssignmentService.ENROLLMENT_SOURCE,
        }:
            for field in ("client_id", "group_id", "assignment_source", "auto_assigned"):
                update_data.pop(field, None)

        update_data["device_type"] = device_type
        update_data["last_seen"] = now
        # Device is now positively identified — clear any stale duplicate state
        update_data["duplicate_candidate"] = False
        update_data["duplicate_of_device_id"] = None
        update_data["duplicate_score"] = None

        logger.info(
            "[fingerprint] auto-reuse: device #%d reused for incoming rustdesk_id=%s (archived=%s)",
            existing.id,
            payload.rustdesk_id,
            existing.is_archived,
        )

        return self.device_repo.update(existing, DeviceUpdate(**update_data))

    def _evaluate_post_heartbeat_alerts(self, device) -> None:
        from app.repositories.device_status_history_repository import DeviceStatusHistoryRepository
        engine = AlertEngine(self.db)
        engine.evaluate_archived_checkin(device)
        engine.evaluate_rustdesk_sync(device)
        window_start = utcnow() - timedelta(seconds=RECONNECT_WINDOW_SECONDS)
        count = DeviceStatusHistoryRepository(self.db).count_recent_online_transitions(device.id, since=window_start)
        engine.evaluate_reconnect(device, count)

    def _maybe_emit_rustdesk_repaired(self, device, previous_count: Optional[int]) -> None:
        current_count = device.rustdesk_repair_count or 0
        if current_count <= (previous_count or 0):
            return
        DeviceActivityEventService(self.db).record(
            device_id=device.id,
            event_type="rustdesk_repaired",
            summary="RustDesk repaired",
            detail=f"Repair count: {current_count}",
            actor="agent",
            fail_silently=True,
        )

    def _process_telemetry(self, payload: AgentHeartbeatPayload, device) -> None:
        has_telemetry = any(
            v is not None
            for v in [payload.cpu_percent, payload.ram_percent, payload.disk_percent, payload.uptime_seconds]
        )
        if not has_telemetry:
            return

        telemetry_service = DeviceTelemetryService(self.heartbeat_repo.db)
        snapshot, prev_state, new_state, reasons = telemetry_service.create_snapshot(
            device_id=device.id,
            cpu_percent=payload.cpu_percent,
            ram_percent=payload.ram_percent,
            disk_percent=payload.disk_percent,
            uptime_seconds=payload.uptime_seconds,
            heartbeat_latency_ms=payload.heartbeat_latency_ms,
        )
        health_score, new_state, reasons = DeviceHealthScoreService(self.db).compute_for_device(device, snapshot)

        realtime_publisher.publish_threadsafe(
            build_event(
                RealtimeEventType.TELEMETRY_UPDATED,
                data={
                    "id": device.id,
                    "cpu_percent": snapshot.cpu_percent,
                    "ram_percent": snapshot.ram_percent,
                    "disk_percent": snapshot.disk_percent,
                    "uptime_seconds": snapshot.uptime_seconds,
                    "heartbeat_latency_ms": snapshot.heartbeat_latency_ms,
                    "health_score": health_score,
                    "health_state": new_state,
                    "health_reasons": reasons,
                },
                reason="heartbeat_telemetry",
            ),
            dedupe_key=f"telemetry:{device.id}",
        )

        AlertEngine(self.db).evaluate_telemetry(
            device,
            cpu_percent=payload.cpu_percent,
            ram_percent=payload.ram_percent,
            disk_percent=payload.disk_percent,
        )

        if prev_state == new_state:
            return

        if new_state == "critical":
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.HEALTH_CRITICAL,
                    data={"id": device.id, "health_state": new_state, "reasons": reasons},
                    reason="health_state_changed",
                )
            )
        elif new_state == "warning":
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.HEALTH_WARNING,
                    data={"id": device.id, "health_state": new_state, "reasons": reasons},
                    reason="health_state_changed",
                )
            )
        elif new_state == "healthy" and prev_state in ("warning", "critical"):
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.HEALTH_RECOVERED,
                    data={"id": device.id, "health_state": new_state},
                    reason="health_recovered",
                )
            )

    def _process_inventory(self, payload: AgentHeartbeatPayload, device) -> None:
        if payload.processes is None and payload.services is None and payload.software is None and payload.patch_status is None:
            return
        try:
            DeviceInventoryService(self.db).save_snapshot(
                device_id=device.id,
                processes=payload.processes,
                services=payload.services,
                software=payload.software,
                patch_status=payload.patch_status,
            )
        except Exception:
            logger.warning("inventory snapshot failed for device %d — heartbeat continues", device.id, exc_info=True)

    def _maybe_emit_user_changed(self, device, prev_user: Optional[str]) -> None:
        def _is_meaningful(u: Optional[str]) -> bool:
            if not u or not u.strip():
                return False
            s = u.strip()
            if s == "No interactive user":
                return False
            if s.endswith("$"):
                return False
            return True

        prev = (prev_user or "").strip()
        next_ = (device.current_user or "").strip()
        if prev == next_:
            return
        if not _is_meaningful(prev) and not _is_meaningful(next_):
            return

        prev_display = prev if _is_meaningful(prev) else "No user"
        next_display = next_ if _is_meaningful(next_) else "No user"
        DeviceActivityEventService(self.db).record(
            device_id=device.id,
            event_type="user_changed",
            summary=f"User changed to {next_display}",
            detail=f"Previous: {prev_display}",
            actor="agent",
            fail_silently=True,
        )

    @staticmethod
    def _has_inventory_change(previous_payload: dict, current_payload: dict) -> bool:
        fields = ("hostname", "device_type", "status", "client_id", "group_id", "current_user")
        return any(previous_payload.get(field) != current_payload.get(field) for field in fields)
