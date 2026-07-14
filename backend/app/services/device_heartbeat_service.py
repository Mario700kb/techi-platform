from __future__ import annotations

import logging
import time
from collections import OrderedDict
from datetime import datetime, timedelta
from app.core.time import utcnow
from typing import Optional

from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_activity_event import DeviceActivityEvent
from app.platform_core.flags import feature_enabled
from app.platform_core.classification import classify_platform
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
from app.services.platform_adapters import get_adapter
from app.services.platform_adapters.windows import classify_windows_device_type
from app.services.rustdesk_service import RustDeskIdentityService
from app.websocket.events import RealtimeEventType, build_event, device_payload, device_payload_delta
from app.websocket.publisher import realtime_publisher

logger = logging.getLogger(__name__)

# Active devices seen within this window are protected from automatic reuse
# when they have a different rustdesk_id (prevents false merge of live machines).
_RECENTLY_SEEN_HOURS = 24

# agent_id → (device_id, cached_at): avoids per-heartbeat agent_id index scans.
# agent_id is immutable post-enroll, so a long TTL is safe.
_AGENT_ID_CACHE: OrderedDict[str, tuple[int, float]] = OrderedDict()
_AGENT_ID_CACHE_TTL = 300.0  # seconds
_AGENT_ID_CACHE_MAX_SIZE = 1000
_AGENT_ID_CACHE_EVICT_COUNT = 100
RUSTDESK_REPAIR_EVENT_THROTTLE_HOURS = 24
RUSTDESK_REPAIR_COUNTER_RETENTION_HOURS = 24


def _cache_agent_device(agent_id: str, device_id: int) -> None:
    _AGENT_ID_CACHE.pop(agent_id, None)
    _AGENT_ID_CACHE[agent_id] = (device_id, time.monotonic())
    if len(_AGENT_ID_CACHE) > _AGENT_ID_CACHE_MAX_SIZE:
        for _ in range(min(_AGENT_ID_CACHE_EVICT_COUNT, len(_AGENT_ID_CACHE))):
            _AGENT_ID_CACHE.popitem(last=False)


def _evict_agent_cache(agent_id: str | None) -> None:
    """Call on device delete/archive so the next heartbeat does a fresh lookup."""
    if agent_id:
        _AGENT_ID_CACHE.pop(agent_id, None)


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
        # Logic moved verbatim to platform_adapters.windows (Phase 1 adapter
        # extraction); this delegation keeps the public API and all callers.
        return classify_windows_device_type(
            os_name,
            domain,
            os_version=os_version,
            os_caption=os_caption,
            os_build=os_build,
            windows_product_type=windows_product_type,
        )

    def process_heartbeat(self, payload: AgentHeartbeatPayload):
        """Synchronous wrapper — keeps existing callers and tests working."""
        device, heartbeat, ctx = self.process_heartbeat_core(payload)
        self._run_side_effects(payload, device, heartbeat.id, ctx)
        return device, heartbeat

    def process_heartbeat_core(self, payload: AgentHeartbeatPayload, *, expected_device_id: Optional[int] = None):
        """
        Fast path: resolve/create/update device record + write heartbeat row.
        Returns (device, heartbeat, ctx) where ctx carries data needed by _run_side_effects.
        """
        if feature_enabled("FEATURE_PLATFORM_CORE"):
            device_type = get_adapter(payload.platform).classify_device_type(payload)
        else:
            device_type = self.classify_device_type(
                payload.os_name,
                payload.domain,
                os_version=payload.os_version,
                os_caption=payload.os_caption,
                os_build=payload.os_build,
                windows_product_type=payload.windows_product_type,
            )
        now = utcnow()
        platform_id = classify_platform(payload.platform)
        if platform_id == "mikrotik":
            aid = payload.agent_id or ""
            # A bare "mikrotik-" (empty serial/software-id) would collapse
            # every such router into one shared device — reject it too.
            if not aid.startswith("mikrotik-") or len(aid) <= len("mikrotik-"):
                raise ValueError("MikroTik heartbeat requires stable agent_id 'mikrotik-<serial-or-software-id>'")
        has_valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )

        device = self.device_repo.get(expected_device_id) if expected_device_id is not None else None
        if device is None and payload.agent_id:
            cached = _AGENT_ID_CACHE.get(payload.agent_id)
            if cached and time.monotonic() - cached[1] < _AGENT_ID_CACHE_TTL:
                _AGENT_ID_CACHE.move_to_end(payload.agent_id)
                device = self.device_repo.get(cached[0])  # PK lookup — faster than agent_id scan
            elif cached:
                _AGENT_ID_CACHE.pop(payload.agent_id, None)
        if device is None and payload.agent_id:
            device = self.device_repo.get_by_agent_id(payload.agent_id)
        if platform_id == "mikrotik" and device is None:
            device = self._create_from_stable_identity(payload, device_type, now)
        if device is None:
            device = self.device_repo.get(payload.device_id) if payload.device_id else None
        if device is None and has_valid_rustdesk_id:
            device = self.device_repo.get_by_rustdesk_id(normalized_rustdesk_id)
        if device is not None and payload.agent_id:
            _cache_agent_device(payload.agent_id, device.id)
        if device is not None:
            device = self.maintenance_service.expire_if_needed(device)
        previous_payload = device_payload(device) if device else None
        prev_user = device.current_user if device else None
        prev_repair_count = device.rustdesk_repair_count if device else 0
        if device:
            update_data = payload.model_dump(
                exclude_unset=True,
                exclude={
                    "device_id", "rustdesk_id", "client_id", "group_id",
                    "rustdesk_sync_status", "remote_support_credential_ack",
                },
            )
            self._drop_stale_repair_counter(update_data, now)
            for field in ("rustdesk_install_status", "rustdesk_status", "rustdesk_version", "rustdesk_install_path"):
                update_data.pop(field, None)
            # Capabilities are normalized + persisted in side effects only
            update_data.pop("capabilities", None)
            if has_valid_rustdesk_id and normalized_rustdesk_id != device.rustdesk_id:
                conflict = self.device_repo.get_conflicting_rustdesk_id(normalized_rustdesk_id, exclude_device_id=device.id)
                if conflict is None:
                    update_data["rustdesk_id"] = normalized_rustdesk_id
            manual_locked = DeviceAssignmentService.is_manual_locked(device.assignment_source)
            if manual_locked:
                for field in ("client_id", "group_id", "assignment_source", "auto_assigned"):
                    update_data.pop(field, None)
            update_data["device_type"] = device_type
            # If device_type changed (e.g. CLIENT → SERVER), allow re-grouping — but
            # NEVER for a manually / enrollment locked device. Clearing the lock here
            # would let reconcile re-assign it, undoing the operator's placement
            # (invariant: heartbeat must never undo a manual assignment).
            if (
                not manual_locked
                and device.device_type != device_type
                and device_type in (DeviceType.SERVER, DeviceType.CLIENT)
            ):
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
        from app.services.remote_action_service import RemoteActionService
        RemoteActionService(self.db).verify_self_update_for_device(device.id)

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

        return device, heartbeat, {
            "previous_payload": previous_payload,
            "current_payload": device_payload(device),
            "prev_user": prev_user,
            "prev_repair_count": prev_repair_count,
        }

    def process_legacy_liveness_heartbeat(self, payload: AgentHeartbeatPayload):
        """Restricted migration path for unauthenticated legacy heartbeats.

        This path intentionally does not create devices, reassign tenants/groups,
        process Remote Support state, acknowledge credentials, deliver actions, or
        run inventory/telemetry side effects. It keeps an already-known device
        visible during migration by updating last_seen/status and recording a
        minimal heartbeat row using the existing device state.
        """
        device = self._resolve_single_existing_legacy_device(payload)
        if payload.client_id is not None and payload.client_id != device.client_id:
            raise ValueError("cross_tenant_identity")
        if payload.group_id is not None and payload.group_id != device.group_id:
            raise ValueError("cross_tenant_identity")

        now = utcnow()
        device.last_seen = now
        device.status = DeviceStatus.ONLINE
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)

        heartbeat = self.heartbeat_repo.create(
            DeviceHeartbeatCreate(
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
        )
        return device, heartbeat

    def _resolve_single_existing_legacy_device(self, payload: AgentHeartbeatPayload) -> Device:
        resolved: dict[int, Device] = {}
        if payload.device_id is not None:
            device = self.device_repo.get(payload.device_id)
            if device is not None:
                resolved[device.id] = device
        if payload.agent_id:
            device = self.device_repo.get_by_agent_id(payload.agent_id)
            if device is not None:
                resolved[device.id] = device
        if payload.rustdesk_id:
            device = self.device_repo.get_by_rustdesk_id(payload.rustdesk_id)
            if device is not None:
                resolved[device.id] = device

        if len(resolved) != 1:
            raise ValueError("legacy heartbeat requires one existing device identity")
        return next(iter(resolved.values()))

    def _create_from_stable_identity(
        self, payload: AgentHeartbeatPayload, device_type: DeviceType, now: datetime
    ) -> Device:
        create_data = payload.model_dump(
            exclude_unset=True,
            exclude={
                "device_id", "rustdesk_id", "capabilities",
                "rustdesk_sync_status", "remote_support_credential_ack",
            },
        )
        self._drop_stale_repair_counter(create_data, now)
        create_data["agent_id"] = payload.agent_id
        create_data["rustdesk_id"] = None
        create_data["device_type"] = device_type
        create_data["status"] = DeviceStatus.OFFLINE
        create_data["last_seen"] = now
        create_data["auto_assigned"] = False
        create_data["assignment_source"] = "system_auto"
        create_data["duplicate_candidate"] = False
        create_data["duplicate_of_device_id"] = None
        create_data["duplicate_score"] = None
        for field in ("current_user", "domain", "public_ip", "local_ip", "cpu", "ram", "storage"):
            create_data.setdefault(field, None)
        return self.device_repo.create(DeviceCreate(**create_data))

    def _run_side_effects(self, payload: AgentHeartbeatPayload, device, heartbeat_id: int, ctx: dict) -> None:
        """
        Realtime events, telemetry, inventory, and alerts.
        Safe to run in a FastAPI BackgroundTask with a fresh DB session.
        """
        current_payload = ctx["current_payload"]
        previous_payload = ctx["previous_payload"]
        prev_user = ctx["prev_user"]
        prev_repair_count = ctx["prev_repair_count"]

        realtime_publisher.publish_threadsafe(
            build_event(
                RealtimeEventType.HEARTBEAT_RECEIVED,
                data={**device_payload_delta(current_payload), "heartbeat_id": heartbeat_id},
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
        # Timeline gets a heartbeat entry only on a real transition (first
        # heartbeat or offline→online recovery) — never per beat.
        if (
            classify_platform(device.platform) == "mikrotik"
            and (previous_payload or {}).get("status") != DeviceStatus.ONLINE.value
        ):
            DeviceActivityEventService(self.db).record(
                device_id=device.id,
                event_type="heartbeat_received",
                summary="Heartbeat received",
                detail="MikroTik connector heartbeat accepted",
                actor="connector",
                fail_silently=True,
            )
        self._process_telemetry(payload, device)
        self._process_inventory(payload, device)
        self._process_capabilities(payload, device)
        self._evaluate_post_heartbeat_alerts(device)

    def _process_capabilities(self, payload: AgentHeartbeatPayload, device) -> None:
        """Persist normalized capabilities (Platform Expansion, flag-gated).

        Off the heartbeat fast path by design; a no-op unless the agent sent a
        capabilities payload AND FEATURE_PLATFORM_CORE is enabled — today's
        Windows fleet never sends one, so this never executes in production
        until the flag is deliberately turned on.
        """
        if payload.capabilities is None or not feature_enabled("FEATURE_PLATFORM_CORE"):
            return
        normalized = get_adapter(device.platform).normalize_capabilities(payload.capabilities)
        if normalized != (device.capabilities or {}):
            device.capabilities = normalized
            self.db.commit()

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

        create_data = payload.model_dump(
            exclude_unset=True,
            exclude={
                "agent_id", "device_id", "rustdesk_id", "capabilities",
                "rustdesk_sync_status", "remote_support_credential_ack",
            },
        )
        self._drop_stale_repair_counter(create_data, now)
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
            exclude={
                "device_id", "rustdesk_id", "capabilities",
                "rustdesk_sync_status", "remote_support_credential_ack",
            },
        )
        self._drop_stale_repair_counter(update_data, now)

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
        if DeviceAssignmentService.is_manual_locked(existing.assignment_source):
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
        # Current heartbeat truth supersedes an inconsistent OPEN offline alert
        # even when the device row was already marked online before this cycle.
        engine.resolve_device_offline(device)
        engine.evaluate_archived_checkin(device)
        engine.evaluate_rustdesk_sync(device)
        window_start = utcnow() - timedelta(seconds=RECONNECT_WINDOW_SECONDS)
        count = DeviceStatusHistoryRepository(self.db).count_recent_online_transitions(device.id, since=window_start)
        engine.evaluate_reconnect(device, count)

    def _maybe_emit_rustdesk_repaired(self, device, previous_count: Optional[int]) -> None:
        current_count = device.rustdesk_repair_count or 0
        if current_count <= (previous_count or 0):
            return
        if self._has_recent_rustdesk_repair_event(device.id):
            return
        DeviceActivityEventService(self.db).record(
            device_id=device.id,
            event_type="rustdesk_repaired",
            summary="TECHI Remote Support repaired",
            detail=f"Repair count: {current_count}",
            actor="agent",
            fail_silently=True,
        )

    def _has_recent_rustdesk_repair_event(self, device_id: int) -> bool:
        cutoff = utcnow() - timedelta(hours=RUSTDESK_REPAIR_EVENT_THROTTLE_HOURS)
        return (
            self.db.query(DeviceActivityEvent.id)
            .filter(
                DeviceActivityEvent.device_id == device_id,
                DeviceActivityEvent.event_type == "rustdesk_repaired",
                DeviceActivityEvent.occurred_at >= cutoff,
            )
            .first()
            is not None
        )

    @staticmethod
    def _drop_stale_repair_counter(values: dict, now: datetime) -> None:
        repair_count = values.get("rustdesk_repair_count")
        repair_at = values.get("rustdesk_last_repair_at")
        if not repair_count:
            return
        if repair_at is None:
            values["rustdesk_repair_count"] = 0
            values["rustdesk_last_repair_at"] = None
            return
        try:
            age = now - repair_at
        except TypeError:
            from app.core.time import ensure_utc
            age = ensure_utc(now) - ensure_utc(repair_at)
        if age > timedelta(hours=RUSTDESK_REPAIR_COUNTER_RETENTION_HOURS):
            values["rustdesk_repair_count"] = 0
            values["rustdesk_last_repair_at"] = None

    def _process_telemetry(self, payload: AgentHeartbeatPayload, device) -> None:
        has_telemetry = any(
            v is not None
            for v in [payload.cpu_percent, payload.ram_percent, payload.disk_percent, payload.uptime_seconds]
        )
        if not has_telemetry:
            return

        telemetry_service = DeviceTelemetryService(self.heartbeat_repo.db)

        # Fetch the previous snapshot BEFORE creating the new one so we can compute
        # prev_state with the same algorithm used for new_state.  Using the simple
        # compute_health() thresholds for prev_state but DeviceHealthScoreService for
        # new_state was the root cause of phantom health-warning events.
        prev_snapshot = telemetry_service.repo.get_latest(device.id)

        snapshot, _, _, _ = telemetry_service.create_snapshot(
            device_id=device.id,
            cpu_percent=payload.cpu_percent,
            ram_percent=payload.ram_percent,
            disk_percent=payload.disk_percent,
            uptime_seconds=payload.uptime_seconds,
            heartbeat_latency_ms=payload.heartbeat_latency_ms,
        )

        score_service = DeviceHealthScoreService(self.db)
        # Compute both states with the identical scoring algorithm
        _, prev_state, _ = score_service.compute_for_device(device, prev_snapshot)
        health_score, new_state, reasons = score_service.compute_for_device(device, snapshot)

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

        # State genuinely changed — emit WebSocket event AND persist to DB so the
        # activity feed shows the same event after a manual Refresh.
        if new_state == "critical":
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.HEALTH_CRITICAL,
                    data={"id": device.id, "health_state": new_state, "reasons": reasons},
                    reason="health_state_changed",
                )
            )
            DeviceActivityEventService(self.db).record(
                device_id=device.id,
                event_type="health_critical",
                summary="Health critical",
                detail=", ".join(reasons) if reasons else None,
                actor="system",
                fail_silently=True,
            )
        elif new_state == "warning":
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.HEALTH_WARNING,
                    data={"id": device.id, "health_state": new_state, "reasons": reasons},
                    reason="health_state_changed",
                )
            )
            DeviceActivityEventService(self.db).record(
                device_id=device.id,
                event_type="health_warning",
                summary="Health warning",
                detail=", ".join(reasons) if reasons else None,
                actor="system",
                fail_silently=True,
            )
        elif new_state == "healthy" and prev_state in ("warning", "critical"):
            realtime_publisher.publish_threadsafe(
                build_event(
                    RealtimeEventType.HEALTH_RECOVERED,
                    data={"id": device.id, "health_state": new_state},
                    reason="health_recovered",
                )
            )
            DeviceActivityEventService(self.db).record(
                device_id=device.id,
                event_type="health_recovered",
                summary="Health recovered",
                actor="system",
                fail_silently=True,
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
            if classify_platform(device.platform) == "mikrotik":
                DeviceActivityEventService(self.db).record(
                    device_id=device.id,
                    event_type="inventory_updated",
                    summary="Inventory updated",
                    detail="MikroTik connector inventory snapshot accepted",
                    actor="connector",
                    fail_silently=True,
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
