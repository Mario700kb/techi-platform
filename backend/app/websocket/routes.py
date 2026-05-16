from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError

from app.core.security import decode_access_token
from app.db.session import SessionLocal
from app.repositories.operator_repository import OperatorRepository
from app.websocket.manager import realtime_manager

router = APIRouter()


async def _authenticate_ws(websocket: WebSocket, token: Optional[str]) -> bool:
    """Validates JWT token before accepting the WebSocket connection.
    Returns False and closes with 4001 if the token is missing or invalid."""
    if not token:
        await websocket.close(code=4001)
        return False
    db = SessionLocal()
    try:
        try:
            payload = decode_access_token(token)
            operator_id = int(payload.get("sub"))
        except (JWTError, TypeError, ValueError):
            await websocket.close(code=4001)
            return False
        operator = OperatorRepository(db).get(operator_id)
        if operator is None or not operator.is_active:
            await websocket.close(code=4001)
            return False
    finally:
        db.close()
    return True


@router.websocket("/ws/devices")
async def devices_websocket(websocket: WebSocket, tenant_id: str = "default", token: Optional[str] = None):
    if not await _authenticate_ws(websocket, token):
        return
    connection_id = await realtime_manager.connect(websocket, tenant_id=tenant_id, channel="devices")
    try:
        while True:
            await websocket.receive_text()
            await realtime_manager.touch(connection_id, tenant_id=tenant_id)
    except WebSocketDisconnect:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)
    except Exception:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)


@router.websocket("/ws/deployments")
async def deployments_websocket(websocket: WebSocket, tenant_id: str = "default", token: Optional[str] = None):
    if not await _authenticate_ws(websocket, token):
        return
    connection_id = await realtime_manager.connect(websocket, tenant_id=tenant_id, channel="deployments")
    try:
        while True:
            await websocket.receive_text()
            await realtime_manager.touch(connection_id, tenant_id=tenant_id)
    except WebSocketDisconnect:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)
    except Exception:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)
