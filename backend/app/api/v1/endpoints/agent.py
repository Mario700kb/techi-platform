import logging
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.agent_auth import (
    AgentAuthError,
    enroll_limiter,
    heartbeat_auth_limiter,
    heartbeat_identity_limiter,
    verify_heartbeat_request,
)
from app.core.config import settings
from app.db.session import get_db, SessionLocal
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import (
    AgentEnrollmentRequest,
    AgentEnrollmentResponse,
    AgentHeartbeatPayload,
    AgentHeartbeatResponse,
)
from app.services import agent_config_service as _cfg_svc
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.remote_action_service import RemoteActionService
from app.services.remote_support_password_service import RemoteSupportPasswordService
from app.services.audit_service import AuditAction, system_audit_log

logger = logging.getLogger(__name__)

router = APIRouter()


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
    claimed_agent_id = request.headers.get("x-techi-agent-id", "").strip() or "missing"
    if not heartbeat_identity_limiter.is_allowed(f"{client_ip}:{claimed_agent_id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many heartbeat authentication attempts")
    try:
        authenticated_device = verify_heartbeat_request(
            db,
            body=await request.body(),
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

    background_tasks.add_task(_heartbeat_side_effects, payload, device.id, heartbeat.id, ctx)

    pending_actions = RemoteActionService(db).collect_pending_for_delivery(device.id)
    interval = _cfg_svc.get_heartbeat_interval(payload.platform)

    credential_service = RemoteSupportPasswordService(db)
    credential_service.process_ack(device, payload.remote_support_credential_ack)
    credential_delivery = credential_service.pending_delivery(device)
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
