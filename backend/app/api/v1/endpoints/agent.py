import logging
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.agent_auth import (
    AgentAuthError,
    enroll_limiter,
    heartbeat_auth_material_missing,
    heartbeat_auth_limiter,
    heartbeat_identity_limiter,
    agent_migration_device_limiter,
    agent_migration_ip_limiter,
    resolve_heartbeat_trust,
)
from app.core.config import settings
from app.core.time import utcnow
from app.db.session import get_db, SessionLocal
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import (
    AgentEnrollmentRequest,
    AgentEnrollmentResponse,
    AgentHeartbeatPayload,
    AgentHeartbeatResponse,
    AgentAuthMigrationChallengeRequest,
    AgentAuthMigrationChallengeResponse,
    AgentAuthMigrationProofRequest,
    AgentAuthMigrationProofResponse,
)
from app.services import agent_config_service as _cfg_svc
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.agent_auth_migration_service import AgentAuthMigrationError, AgentAuthMigrationService
from app.services.agent_package_service import AgentPackageService
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.remote_action_service import RemoteActionService
from app.services.remote_support_password_service import RemoteSupportPasswordService
from app.services.audit_service import AuditAction, system_audit_log

logger = logging.getLogger(__name__)

router = APIRouter()

_CREDENTIAL_RETRY_MIN_AGENT_VERSION = (2, 1, 12)


def _agent_supports_credential_retry(raw_version: Optional[str]) -> bool:
    text = (raw_version or "").strip().lstrip("vV")
    try:
        version = tuple(int(piece) for piece in text.split("."))
    except (TypeError, ValueError):
        return False
    return version >= _CREDENTIAL_RETRY_MIN_AGENT_VERSION


def _record_heartbeat_trust_transition(
    db: Session,
    *,
    device,
    state: str,
    source_ip: str,
    mode: str,
    reason: str,
) -> None:
    """Persist and audit trust transitions, never individual heartbeats."""
    previous = device.heartbeat_auth_state or "unknown"
    if previous == state:
        return
    device.heartbeat_auth_state = state
    device.heartbeat_auth_state_changed_at = utcnow()
    db.add(device)
    db.commit()
    db.refresh(device)

    if state == "legacy_restricted":
        action = AuditAction.AGENT_HEARTBEAT_LEGACY_ACCEPTED
    elif previous == "legacy_restricted" and state == "authenticated":
        action = AuditAction.AGENT_HEARTBEAT_AUTHENTICATED
    else:
        return
    system_audit_log(
        db,
        action=action,
        entity_type="device",
        entity_id=device.id,
        details={
            "transition": f"{previous}->{state}",
            "reason": reason,
            "source_ip": source_ip,
            "mode": mode,
        },
    )


def _normalize_public_backend_url(request: Request) -> str:
    configured_url = (settings.PUBLIC_BACKEND_URL or "").strip().rstrip("/")
    raw = configured_url or str(request.base_url).strip().rstrip("/")
    parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
    return urlunsplit(("https", parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _public_websocket_url(base_url: str) -> str:
    parsed = urlsplit(base_url if "://" in base_url else f"https://{base_url}")
    return urlunsplit(("wss", parsed.netloc, "/ws/devices", "tenant_id=default", ""))


def _heartbeat_side_effects(
    payload: AgentHeartbeatPayload,
    device_id: int,
    heartbeat_id: int,
    ctx: dict,
) -> None:
    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is None:
            return
        DeviceHeartbeatService(db)._run_side_effects(payload, device, heartbeat_id, ctx)
    except Exception:
        logger.exception("heartbeat side-effects failed for device %d", device_id)
    finally:
        db.close()


def _heartbeat_identity_rate_limit_key(request: Request, payload: AgentHeartbeatPayload, client_ip: str) -> str:
    header_agent_id = request.headers.get("x-techi-agent-id", "").strip()
    if header_agent_id:
        return f"{client_ip}:{header_agent_id}"

    if (
        settings.AGENT_HEARTBEAT_AUTH_MODE in {"observe", "disabled"}
        and heartbeat_auth_material_missing(request.headers)
    ):
        legacy_identity = (
            payload.agent_id
            or (f"device:{payload.device_id}" if payload.device_id is not None else "")
            or (f"rustdesk:{payload.rustdesk_id}" if payload.rustdesk_id else "")
            or "missing"
        )
        return f"{client_ip}:legacy:{legacy_identity}"

    return f"{client_ip}:missing"


def _migration_rate_limit(request: Request, device_id: int) -> None:
    client_ip = request.client.host if request.client else "unknown"
    if not agent_migration_ip_limiter.is_allowed(client_ip) or not agent_migration_device_limiter.is_allowed(str(device_id)):
        raise HTTPException(status_code=429, detail="Too many Agent migration attempts")


@router.post("/auth-migration/challenge", response_model=AgentAuthMigrationChallengeResponse)
def agent_auth_migration_challenge(
    payload: AgentAuthMigrationChallengeRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    _migration_rate_limit(request, payload.device_id)
    try:
        return AgentAuthMigrationService(db).challenge(**payload.model_dump())
    except AgentAuthMigrationError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


@router.post("/auth-migration/prove", response_model=AgentAuthMigrationProofResponse)
def agent_auth_migration_prove(
    payload: AgentAuthMigrationProofRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    _migration_rate_limit(request, payload.device_id)
    try:
        return AgentAuthMigrationService(db).prove(**payload.model_dump())
    except AgentAuthMigrationError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


def _legacy_migration_update(request: Request, device, reported_version: Optional[str]):
    if not AgentAuthMigrationService.allowed(device.id):
        return None
    package = AgentPackageService().latest_active("windows-amd64", file_type="agent_binary")
    if package is None or package.version == (reported_version or "").strip():
        return None
    base_url = _normalize_public_backend_url(request)
    return {
        "available": True,
        "version": package.version,
        "download_url": f"{base_url}{settings.API_PREFIX}/agent-packages/agent-binary/download",
        "sha256": package.sha256,
    }


@router.post("/enroll", response_model=AgentEnrollmentResponse)
def agent_enroll(
    payload: AgentEnrollmentRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    First-run enrollment handshake for agents with a one-time enrollment token.
    """
    client_ip = request.client.host if request.client else "unknown"
    if not enroll_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many enrollment attempts")
    base_url = _normalize_public_backend_url(request)
    websocket_url = _public_websocket_url(base_url)
    service = AgentEnrollmentService(db)
    try:
        return service.enroll(
            payload,
            heartbeat_url=f"{base_url}/api/v1/agent/heartbeat",
            websocket_url=websocket_url,
        )
    except ValueError as exc:
        detail = str(exc)
        if detail == "used":
            raise HTTPException(status_code=400, detail="Enrollment token exhausted, max_uses reached")
        if detail in {"invalid", "expired", "revoked"}:
            raise HTTPException(status_code=400, detail=f"Enrollment token is {detail}")
        if "enrollment_token is required" in detail or "not trusted" in detail:
            raise HTTPException(status_code=403, detail=detail)
        raise HTTPException(status_code=400, detail=detail)


@router.post("/heartbeat", response_model=AgentHeartbeatResponse)
async def agent_heartbeat(
    payload: AgentHeartbeatPayload,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Agent heartbeat endpoint. Returns immediately after writing the device record;
    telemetry, inventory, alerts, and realtime events run in a background task.
    """
    client_ip = request.client.host if request.client else "unknown"
    if not heartbeat_auth_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many heartbeat authentication attempts")
    identity_rate_limit_key = _heartbeat_identity_rate_limit_key(request, payload, client_ip)
    if not heartbeat_identity_limiter.is_allowed(identity_rate_limit_key):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many heartbeat authentication attempts")
    body = await request.body()
    try:
        trust = resolve_heartbeat_trust(
            db,
            body=body,
            headers=request.headers,
            payload=payload,
        )
    except AgentAuthError as exc:
        system_audit_log(
            db,
            action=AuditAction.AGENT_HEARTBEAT_AUTH_FAILED,
            entity_type="device",
            details={"reason": exc.reason, "source_ip": client_ip},
        )
        detail = (
            "Agent re-enrollment is required before authenticated heartbeats can resume"
            if exc.status_code == 428
            else "Invalid Agent heartbeat authentication"
        )
        raise HTTPException(status_code=exc.status_code, detail=detail)

    if trust.legacy_restricted:
        service = DeviceHeartbeatService(db)
        try:
            device, heartbeat = service.process_legacy_liveness_heartbeat(payload)
        except ValueError as exc:
            system_audit_log(
                db,
                action=AuditAction.AGENT_HEARTBEAT_AUTH_FAILED,
                entity_type="device",
                details={
                    "reason": str(exc),
                    "source_ip": client_ip,
                    "mode": trust.mode,
                    "trust": "legacy_restricted",
                },
            )
            raise HTTPException(status_code=400, detail=str(exc))

        _record_heartbeat_trust_transition(
            db,
            device=device,
            state="legacy_restricted",
            source_ip=client_ip,
            mode=trust.mode,
            reason=trust.reason,
        )
        interval = _cfg_svc.get_heartbeat_interval(payload.platform)
        return {
            "device_id": device.id,
            "heartbeat_id": heartbeat.id,
            "rustdesk_id": device.rustdesk_id,
            "device_type": device.device_type,
            "status": device.status,
            "last_seen": device.last_seen,
            "heartbeat_at": heartbeat.created_at,
            "pending_actions": [],
            "heartbeat_interval_seconds": interval,
            "agent_update": _legacy_migration_update(request, device, payload.agent_version),
            "authentication_required": True,
            "remote_support_credential": None,
        }

    authenticated_device = trust.device
    credential_service = RemoteSupportPasswordService(db)
    credential_service.process_ack(authenticated_device, payload.remote_support_credential_ack)

    if not payload.public_ip:
        forwarded_for = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
        client_ip = forwarded_for or (request.client.host if request.client else None)
        if client_ip:
            payload = payload.model_copy(update={"public_ip": client_ip})

    service = DeviceHeartbeatService(db)
    try:
        device, heartbeat, ctx = service.process_heartbeat_core(
            payload,
            expected_device_id=authenticated_device.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    _record_heartbeat_trust_transition(
        db,
        device=device,
        state="authenticated",
        source_ip=client_ip,
        mode=trust.mode,
        reason=trust.reason,
    )

    background_tasks.add_task(_heartbeat_side_effects, payload, device.id, heartbeat.id, ctx)

    _apply_remote_support_sync_contract(db, device, payload.rustdesk_sync_status)

    pending_actions = RemoteActionService(db).collect_pending_for_delivery(device.id)
    interval = _cfg_svc.get_heartbeat_interval(payload.platform)

    credential_delivery = credential_service.pending_delivery(
        device,
        retry_failed=_agent_supports_credential_retry(payload.agent_version),
    )
    platform = (payload.platform or "").strip().lower()
    remote_support_present = payload.rustdesk_install_status != "not_installed"
    if credential_delivery is None and platform == "windows" and remote_support_present:
        if device.remote_support_apply_status in ("unknown", "unsupported_legacy"):
            credential_delivery = credential_service.ensure_desired(device)

    return {
        "device_id": device.id,
        "heartbeat_id": heartbeat.id,
        "rustdesk_id": device.rustdesk_id,
        "device_type": device.device_type,
        "status": device.status,
        "last_seen": device.last_seen,
        "heartbeat_at": heartbeat.created_at,
        "pending_actions": [a.model_dump() for a in pending_actions],
        "heartbeat_interval_seconds": interval,
        "agent_update": None,  # populated in Faza 3 when agent-packages service is ready
        "remote_support_credential": credential_delivery.__dict__ if credential_delivery else None,
    }


def _apply_remote_support_sync_contract(db: Session, device, reported_status: Optional[str]) -> None:
    reported = (reported_status or "unknown").strip().lower()
    allowed = {"unknown", "pending", "applied", "failed", "conflicted", "unsupported_legacy"}
    if reported not in allowed:
        reported = "unknown"

    credential_status = device.remote_support_apply_status or "unknown"
    if credential_status == "unsupported_legacy":
        state = "unsupported_legacy"
    elif credential_status == "failed":
        state = "failed"
    elif credential_status in {"unknown", "pending"}:
        state = credential_status
    elif (
        credential_status == "applied"
        and device.remote_support_active_generation == device.remote_support_applied_generation
    ):
        state = reported
    else:
        state = "conflicted"

    device.rustdesk_sync_state = state
    device.rustdesk_sync_message = None if state == "applied" else f"Remote Support credential/config state: {state}"
    if state == "applied":
        device.rustdesk_synced_at = utcnow()
    db.add(device)
    db.commit()
    db.refresh(device)
