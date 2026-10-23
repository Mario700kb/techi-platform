from __future__ import annotations

import logging
import secrets
import threading
from dataclasses import dataclass
import time
from collections import Counter, OrderedDict
from datetime import datetime, timedelta
from app.core.time import utcnow, utcnow_naive
from typing import Optional

from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_activity_event import DeviceActivityEvent
from app.platform_core.flags import feature_enabled
from app.platform_core.classification import classify_platform
from app.repositories.device_repository import DeviceRepository
from app.repositories.device_heartbeat_repository import DeviceHeartbeatRepository
from app.schemas.agent import AgentHeartbeatPayload
from app.schemas.device_health import parse_device_health
from app.schemas.device_inventory import PatchStatusSnapshot
from app.schemas.security_posture import parse_security_posture
from app.services.remote_session_service import RemoteSessionService
from app.schemas.device import DeviceCreate, DeviceUpdate
from app.services.alert_engine import AlertEngine
from app.services.agent_revocation import refuse_if_revoked
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
from app.services.remote_support_presence import RemoteSupportPresence, normalize_guid
from app.services.rustdesk_service import RustDeskIdentityService
from app.websocket.events import RealtimeEventType, build_event, device_payload, device_payload_delta
from app.websocket.publisher import realtime_publisher


@dataclass(frozen=True)
class HeartbeatRef:
    """The heartbeat just processed, as the response and realtime event name it."""

    id: int
    created_at: datetime


logger = logging.getLogger(__name__)

# Active devices seen within this window are protected from automatic reuse
# when they have a different rustdesk_id (prevents false merge of live machines).
_RECENTLY_SEEN_HOURS = 24

# agent_id → (device_id, cached_at): avoids per-heartbeat agent_id index scans.
# agent_id is immutable post-enroll, so a long TTL is safe.
# A lock: heartbeats run in several worker threads, and an eviction between a
# get and a move_to_end raised KeyError (a 500 and an agent retry). The TTL is
# longer than the ~5 min heartbeat interval, or almost every lookup missed;
# identity is re-checked on every hit anyway.
_AGENT_ID_CACHE: OrderedDict[str, tuple[int, float]] = OrderedDict()
_AGENT_ID_CACHE_LOCK = threading.Lock()
_AGENT_ID_CACHE_TTL = 3600.0  # seconds
_AGENT_ID_CACHE_MAX_SIZE = 4000
_AGENT_ID_CACHE_EVICT_COUNT = 100
RUSTDESK_REPAIR_EVENT_THROTTLE_HOURS = 24
RUSTDESK_REPAIR_COUNTER_RETENTION_HOURS = 24

# RISK-IDENT-001 instrumentation. device_id -> last time we logged it, so a
# device stuck in this state produces one line an hour instead of one every
# heartbeat. Observation only; nothing branches on this.
_UNVERIFIED_DEVICE_ID_SEEN: dict = {}
_UNVERIFIED_DEVICE_ID_THROTTLE_SECONDS = 3600.0


def _note_unverified_device_id_resolution(payload, device, via: str = "device_id") -> None:
    """Log a heartbeat resolved from payload.device_id (or, via=, its
    rustdesk_id or hardware fingerprint) whose agent_id disagrees.

    This is the exact population that would stop resolving if device_id
    resolution were gated on a matching agent_id. Logging it now gives that
    change a measured blast radius instead of a guessed one.
    """
    if device is None:
        return
    provided = (getattr(payload, "agent_id", None) or "").strip()
    stored = (getattr(device, "agent_id", None) or "").strip()
    if not provided or not stored or provided == stored:
        return
    now = time.monotonic()
    last = _UNVERIFIED_DEVICE_ID_SEEN.get(device.id)
    if last is not None and now - last < _UNVERIFIED_DEVICE_ID_THROTTLE_SECONDS:
        return
    _UNVERIFIED_DEVICE_ID_SEEN[device.id] = now
    logger.warning(
        "RISK-IDENT-001: heartbeat resolved via %s to device_id=%s but agent_id disagrees "
        "(hostname=%s); this device would stop resolving if resolution required a "
        "matching agent_id",
        via,
        device.id,
        getattr(payload, "hostname", None),
    )


def _proves_identity(payload, device) -> bool:
    """True when the heartbeat carries the agent_id stored on this device.

    Only such a heartbeat may change the device's identity. Both sides must be
    non-empty, so a caller that omits agent_id never matches a device without one.
    """
    if device is None:
        return False
    provided = (getattr(payload, "agent_id", None) or "").strip()
    stored = (getattr(device, "agent_id", None) or "").strip()
    return bool(provided) and bool(stored) and secrets.compare_digest(provided, stored)


def _cache_agent_device(agent_id: str, device_id: int) -> None:
    with _AGENT_ID_CACHE_LOCK:
        _AGENT_ID_CACHE.pop(agent_id, None)
        _AGENT_ID_CACHE[agent_id] = (device_id, time.monotonic())
        if len(_AGENT_ID_CACHE) > _AGENT_ID_CACHE_MAX_SIZE:
            for _ in range(min(_AGENT_ID_CACHE_EVICT_COUNT, len(_AGENT_ID_CACHE))):
                _AGENT_ID_CACHE.popitem(last=False)


def _cached_device_id(agent_id: str) -> Optional[int]:
    with _AGENT_ID_CACHE_LOCK:
        cached = _AGENT_ID_CACHE.get(agent_id)
        if cached is None:
            return None
        if time.monotonic() - cached[1] >= _AGENT_ID_CACHE_TTL:
            _AGENT_ID_CACHE.pop(agent_id, None)
            return None
        _AGENT_ID_CACHE.move_to_end(agent_id)
        return cached[0]


def _evict_agent_cache(agent_id: str | None) -> None:
    """Call on device delete/archive so the next heartbeat does a fresh lookup."""
    if agent_id:
        with _AGENT_ID_CACHE_LOCK:
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

    def process_heartbeat_core(self, payload: AgentHeartbeatPayload):
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

        device = None
        if payload.agent_id:
            cached_id = _cached_device_id(payload.agent_id)
            if cached_id is not None:
                device = self.device_repo.get(cached_id)  # PK lookup — faster than agent_id scan
                if not _proves_identity(payload, device):
                    _evict_agent_cache(payload.agent_id)
                    device = None
        if device is None and payload.agent_id:
            device = self.device_repo.get_by_agent_id(payload.agent_id)
        # A revoked agent (its device archived or in the trash) is refused
        # before it can update the device or, once the device is gone, come
        # back as a new one. Live devices never reach the lookup.
        if payload.agent_id and (device is None or device.is_archived):
            refuse_if_revoked(self.db, payload.agent_id, payload.public_ip)
        if platform_id == "mikrotik" and device is None:
            device = self._create_from_stable_identity(payload, device_type, now)
        if device is None:
            device = self.device_repo.get(payload.device_id) if payload.device_id else None
            # OBSERVE ONLY (RISK-IDENT-001). Resolving from a caller-supplied
            # device_id without checking agent_id is how two cloned machines
            # ended up fighting over device 774 on 2026-08-03. The fix is to
            # stop trusting device_id when agent_id disagrees — but that would
            # silently drop every device currently relying on this path, and
            # the size of that set is unknown. Measure it before changing it.
            _note_unverified_device_id_resolution(payload, device)
        if device is None and has_valid_rustdesk_id:
            device = self.device_repo.get_by_rustdesk_id(normalized_rustdesk_id)
            _note_unverified_device_id_resolution(payload, device, via="rustdesk_id")
        # A heartbeat that does not carry the device's own agent_id may report
        # status and inventory, but must not change who the device is: no
        # agent_id, rustdesk_id or client/group from it. Overwriting agent_id
        # from such a heartbeat let anyone unlock the device's Remote Support
        # password and pending actions with one request per device_id.
        verified = _proves_identity(payload, device)
        if verified:
            _cache_agent_device(payload.agent_id, device.id)
        if device is not None:
            device = self.maintenance_service.expire_if_needed(device)
        previous_payload = device_payload(device) if device else None
        prev_user = device.current_user if device else None
        prev_repair_count = device.rustdesk_repair_count if device else 0
        if device:
            update_data = payload.model_dump(exclude_unset=True, exclude={"device_id", "rustdesk_id", "agent_id"})
            if not verified:
                # An unverified caller reports status, but must not move the
                # device's network identity: public_ip gates the RustDesk audit
                # check, and agent_version/sha complete a pending self_update.
                for field in ("public_ip", "agent_version", "agent_sha256"):
                    update_data.pop(field, None)
            self._drop_stale_repair_counter(update_data, now)
            for field in ("rustdesk_install_status", "rustdesk_status", "rustdesk_version", "rustdesk_install_path"):
                update_data.pop(field, None)
            # Capabilities are normalized + persisted in side effects only
            update_data.pop("capabilities", None)
            if (
                verified
                and has_valid_rustdesk_id
                and normalized_rustdesk_id != device.rustdesk_id
                # Remote Support's own recent report decides; the agent's
                # reading of config files gives way to it.
                and not RemoteSupportPresence.client_is_authority(device, now)
            ):
                conflict = self.device_repo.get_conflicting_rustdesk_id(normalized_rustdesk_id, exclude_device_id=device.id)
                if conflict is None:
                    update_data["rustdesk_id"] = normalized_rustdesk_id
            if verified:
                guid = normalize_guid(payload.machine_guid)
                if guid and device.machine_guid != guid:
                    device.machine_guid = guid
                agent_id_report = normalized_rustdesk_id if has_valid_rustdesk_id else None
                if device.agent_rustdesk_id != agent_id_report:
                    device.agent_rustdesk_id = agent_id_report
            manual_locked = DeviceAssignmentService.is_manual_locked(device.assignment_source)
            if manual_locked or not verified:
                for field in ("client_id", "group_id", "assignment_source", "auto_assigned"):
                    update_data.pop(field, None)
            update_data["device_type"] = device_type
            # If device_type changed (e.g. CLIENT → SERVER), allow re-grouping — but
            # NEVER for a manually / enrollment locked device. Clearing the lock here
            # would let reconcile re-assign it, undoing the operator's placement
            # (invariant: heartbeat must never undo a manual assignment).
            if (
                verified
                and not manual_locked
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
            verified = _proves_identity(payload, device)
            _note_unverified_device_id_resolution(payload, device, via="fingerprint")

        device = self.status_service.mark_online_from_heartbeat(device)
        if verified:
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
        if verified:
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

        # Heartbeats are no longer stored one row each (634 MB for a timeline
        # that showed the last 100): devices.last_seen and the status history
        # carry what the console needs. The response still names the beat.
        heartbeat = HeartbeatRef(id=int(now.timestamp()) % 2_000_000_000, created_at=now)

        return device, heartbeat, {
            "previous_payload": previous_payload,
            "current_payload": device_payload(device),
            "prev_user": prev_user,
            "prev_repair_count": prev_repair_count,
            "verified": verified,
        }

    def _create_from_stable_identity(
        self, payload: AgentHeartbeatPayload, device_type: DeviceType, now: datetime
    ) -> Device:
        create_data = payload.model_dump(
            exclude_unset=True,
            exclude={"device_id", "rustdesk_id", "capabilities"},
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
        # One read of the device's open alerts serves every resolve check and
        # the health score below.
        alerts = AlertEngine(self.db)
        open_alerts = alerts.prefetch_open(device.id)
        self._process_telemetry(payload, device, alerts=alerts, open_alerts=open_alerts)
        self._process_inventory(payload, device, verified=bool(ctx.get("verified")))
        self._process_capabilities(payload, device)
        # Only a verified agent may drive the device's Remote Support session
        # flag; an unverified caller (a clone, a probe) must not start or end it.
        if ctx.get("verified"):
            if payload.remote_session_active is False:
                # Ground truth from the device: no session runs, so any
                # connection still open here lost its close report.
                from app.services.rustdesk_audit_service import RustDeskAuditService

                RustDeskAuditService(self.db).close_lost_connections(device, utcnow_naive())
            RemoteSessionService(self.db).apply_report(device, payload.remote_session_active)
        self._evaluate_post_heartbeat_alerts(device, alerts)

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
            exclude_unset=True, exclude={"agent_id", "device_id", "rustdesk_id", "capabilities"}
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
            exclude={"device_id", "rustdesk_id", "agent_id", "capabilities"},
        )
        self._drop_stale_repair_counter(update_data, now)

        # Rustdesk runtime fields are synced separately by apply_heartbeat_sync
        for field in ("rustdesk_install_status", "rustdesk_status", "rustdesk_version", "rustdesk_install_path"):
            update_data.pop(field, None)

        # Archived state must never be touched by duplicate logic
        for field in ("is_archived", "archived_at", "archived_by"):
            update_data.pop(field, None)

        # Attempt rustdesk_id update only when no other device already holds that ID,
        # and only for the agent the device belongs to (a fingerprint is not proof).
        has_valid_rustdesk_id, normalized_rustdesk_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            payload.rustdesk_id or ""
        )
        if (
            _proves_identity(payload, existing)
            and has_valid_rustdesk_id
            and normalized_rustdesk_id != existing.rustdesk_id
        ):
            conflict = self.device_repo.get_conflicting_rustdesk_id(
                normalized_rustdesk_id, exclude_device_id=existing.id
            )
            if conflict is None:
                update_data["rustdesk_id"] = normalized_rustdesk_id

        # Preserve manual / enrollment-token assignment — never override on reuse
        if DeviceAssignmentService.is_manual_locked(existing.assignment_source) or not _proves_identity(
            payload, existing
        ):
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

    def _evaluate_post_heartbeat_alerts(self, device, engine: Optional[AlertEngine] = None) -> None:
        from app.repositories.device_status_history_repository import DeviceStatusHistoryRepository
        engine = engine or AlertEngine(self.db)
        engine.evaluate_archived_checkin(device)
        engine.evaluate_rustdesk_sync(device)
        window_start = utcnow() - timedelta(seconds=RECONNECT_WINDOW_SECONDS)
        drops = DeviceStatusHistoryRepository(self.db).count_recent_connection_drops(device.id, since=window_start)
        engine.evaluate_reconnect(device, drops)

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

    def _process_telemetry(
        self, payload: AgentHeartbeatPayload, device, alerts: Optional[AlertEngine] = None, open_alerts=None
    ) -> None:
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

        snapshot = telemetry_service.repo.create(
            device_id=device.id,
            cpu_percent=payload.cpu_percent,
            ram_percent=payload.ram_percent,
            disk_percent=payload.disk_percent,
            uptime_seconds=payload.uptime_seconds,
            heartbeat_latency_ms=payload.heartbeat_latency_ms,
        )

        score_service = DeviceHealthScoreService(self.db)
        # Both states with the identical scoring algorithm and the same inputs,
        # read once: the open alerts and the inventory row.
        alert_counts = None
        if open_alerts is not None:
            alert_counts = dict(Counter(alert.severity.value for alert in open_alerts))
        inventory = score_service.inventory_repo.get_by_device(device.id)
        _, prev_state, _ = score_service.compute_for_device(
            device, prev_snapshot, alert_counts=alert_counts, inventory=inventory
        )
        health_score, new_state, reasons = score_service.compute_for_device(
            device, snapshot, alert_counts=alert_counts, inventory=inventory
        )

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

        # An agent that evaluates its own policy monitors (>= 2.1.29) raises
        # CPU/memory/disk alerts itself, every minute; evaluating the 5-minute
        # heartbeat too would open the same alerts twice.
        from app.services.telemetry_ingest_service import devices_with_agent_monitoring

        if not devices_with_agent_monitoring(self.db, {device.id}):
            (alerts or AlertEngine(self.db)).evaluate_telemetry(
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

    def _process_inventory(self, payload: AgentHeartbeatPayload, device, verified: bool = False) -> None:
        posture = None
        if payload.security_posture is not None:
            # Who is a local administrator and whether the disk is encrypted
            # is identity-sensitive: only the device's own agent may set it.
            if verified:
                posture = parse_security_posture(payload.security_posture, device_id=device.id)
            else:
                logger.info("device %d: security_posture from an unverified heartbeat ignored", device.id)
        health = None
        if payload.device_health is not None:
            if verified:
                health = parse_device_health(payload.device_health, device_id=device.id)
            else:
                logger.info("device %d: device_health from an unverified heartbeat ignored", device.id)
        if (
            payload.processes is None
            and payload.services is None
            and payload.software is None
            and payload.patch_status is None
            and posture is None
            and health is None
        ):
            return
        try:
            previous_posture = DeviceInventoryService(self.db).save_snapshot(
                device_id=device.id,
                processes=payload.processes,
                services=payload.services,
                software=payload.software,
                patch_status=payload.patch_status,
                security_posture=posture,
                device_health=health,
            )
            if posture is not None or health is not None:
                # Security score, disk health, critical events and a pending
                # restart are judged by the platform when a report arrives.
                from app.services.monitor_alert_service import MonitorAlertService

                MonitorAlertService(self.db).evaluate_reports(device, previous_posture=previous_posture)
            if classify_platform(device.platform) == "mikrotik":
                DeviceActivityEventService(self.db).record(
                    device_id=device.id,
                    event_type="inventory_updated",
                    summary="Inventory updated",
                    detail="MikroTik connector inventory snapshot accepted",
                    actor="connector",
                    fail_silently=True,
                )
            if payload.patch_status:
                self._publish_patch_status(device, payload.patch_status)
        except Exception:
            logger.warning("inventory snapshot failed for device %d — heartbeat continues", device.id, exc_info=True)

    @staticmethod
    def _publish_patch_status(device, patch_status: dict) -> None:
        """The update count on every open screen (table chip, drawer, Overview)
        follows the agent's report instead of waiting for a reload."""
        patch = PatchStatusSnapshot.model_validate({**patch_status, "device_id": device.id})
        realtime_publisher.publish_threadsafe(
            build_event(
                RealtimeEventType.PATCH_STATUS_UPDATED,
                data={
                    "id": device.id,
                    "client_id": device.client_id,
                    "group_id": device.group_id,
                    **patch.model_dump(exclude={"device_id"}),
                },
                reason="heartbeat_patch_status",
            ),
            dedupe_key=f"patch_status:{device.id}",
        )

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
        # agent_version/agent_sha256: a self-update landing must refresh the
        # device's "Installed" version on open pages.
        fields = ("hostname", "device_type", "status", "client_id", "group_id", "current_user",
                  "agent_version", "agent_sha256")
        return any(previous_payload.get(field) != current_payload.get(field) for field in fields)
