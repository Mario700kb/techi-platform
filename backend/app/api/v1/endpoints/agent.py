from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.agent import AgentHeartbeatPayload, AgentHeartbeatResponse
from app.services.device_heartbeat_service import DeviceHeartbeatService

router = APIRouter()


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

    return {
        "device_id": device.id,
        "heartbeat_id": heartbeat.id,
        "rustdesk_id": device.rustdesk_id,
        "device_type": device.device_type,
        "status": device.status,
        "last_seen": device.last_seen,
        "heartbeat_at": heartbeat.created_at,
    }
