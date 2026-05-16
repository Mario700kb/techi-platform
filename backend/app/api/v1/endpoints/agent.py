from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.agent_auth import enroll_limiter
from app.db.session import get_db
from app.schemas.agent import (
    AgentEnrollmentRequest,
    AgentEnrollmentResponse,
    AgentHeartbeatPayload,
    AgentHeartbeatResponse,
)
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.remote_action_service import RemoteActionService

router = APIRouter()


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
    base_url = str(request.base_url).rstrip("/")
    websocket_scheme = "wss" if request.url.scheme == "https" else "ws"
    websocket_url = f"{websocket_scheme}://{request.url.netloc}/ws/devices?tenant_id=default"
    service = AgentEnrollmentService(db)
    try:
        return service.enroll(
            payload,
            heartbeat_url=f"{base_url}/api/v1/agent/heartbeat",
            websocket_url=websocket_url,
        )
    except ValueError as exc:
        detail = str(exc)
        if detail in {"invalid", "expired", "revoked", "used"}:
            raise HTTPException(status_code=400, detail=f"Enrollment token is {detail}")
        if "enrollment_token is required" in detail or "not trusted" in detail:
            raise HTTPException(status_code=403, detail=detail)
        raise HTTPException(status_code=400, detail=detail)


@router.post("/heartbeat", response_model=AgentHeartbeatResponse)
def agent_heartbeat(
    payload: AgentHeartbeatPayload,
    db: Session = Depends(get_db),
):
    """
    Agent heartbeat endpoint. The agent sends inventory data and the backend records a heartbeat.
    """
    service = DeviceHeartbeatService(db)
    try:
        device, heartbeat = service.process_heartbeat(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    pending_actions = RemoteActionService(db).collect_pending_for_delivery(device.id)

    return {
        "device_id": device.id,
        "heartbeat_id": heartbeat.id,
        "rustdesk_id": device.rustdesk_id,
        "device_type": device.device_type,
        "status": device.status,
        "last_seen": device.last_seen,
        "heartbeat_at": heartbeat.created_at,
        "pending_actions": [a.model_dump() for a in pending_actions],
    }
