import logging
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.agent_auth import enroll_limiter
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
def agent_heartbeat(
    payload: AgentHeartbeatPayload,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Agent heartbeat endpoint. Returns immediately after writing the device record;
    telemetry, inventory, alerts, and realtime events run in a background task.
    """
    service = DeviceHeartbeatService(db)
    try:
        device, heartbeat, ctx = service.process_heartbeat_core(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    background_tasks.add_task(_heartbeat_side_effects, payload, device.id, heartbeat.id, ctx)

    pending_actions = RemoteActionService(db).collect_pending_for_delivery(device.id)
    interval = _cfg_svc.get_policy()["heartbeat_interval_seconds"]

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
    }
