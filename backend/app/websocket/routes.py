from typing import Optional, Tuple, Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError

from app.core.security import decode_access_token
from app.db.session import SessionLocal
from app.repositories.operator_repository import OperatorRepository
from app.websocket.manager import realtime_manager

router = APIRouter()

# Sentinel returned when WebSocket authentication fails.
_AUTH_FAILED = object()


async def _authenticate_ws(websocket: WebSocket, token: Optional[str]) -> Any:
    """Validate JWT, resolve operator scope, and return it.

    Returns:
      - None if the operator is unrestricted (admin/owner — no scope filter).
      - An AllowedScope instance for operator/readonly accounts.
      - _AUTH_FAILED if the token is missing/invalid or the operator is inactive
        (the WebSocket is also closed with code 4001 in that case).
    """
    if not token:
        await websocket.close(code=4001)
        return _AUTH_FAILED

    db = SessionLocal()
    try:
        try:
            payload = decode_access_token(token)
            operator_id = int(payload.get("sub"))
        except (JWTError, TypeError, ValueError):
            await websocket.close(code=4001)
            return _AUTH_FAILED

        operator = OperatorRepository(db).get(operator_id)
        if operator is None or not operator.is_active:
            await websocket.close(code=4001)
            return _AUTH_FAILED

        from app.core.auth import is_unrestricted
        from app.services.team_service import TeamScopeService

        if is_unrestricted(operator):
            return None  # admin/owner: no restriction

        return TeamScopeService(db).get_team_scope_for_operator(operator.id)
    finally:
        db.close()


@router.websocket("/ws/devices")
async def devices_websocket(websocket: WebSocket, tenant_id: str = "default", token: Optional[str] = None):
    scope = await _authenticate_ws(websocket, token)
    if scope is _AUTH_FAILED:
        return
    connection_id = await realtime_manager.connect(
        websocket, tenant_id=tenant_id, channel="devices", operator_scope=scope
    )
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
    scope = await _authenticate_ws(websocket, token)
    if scope is _AUTH_FAILED:
        return
    connection_id = await realtime_manager.connect(
        websocket, tenant_id=tenant_id, channel="deployments", operator_scope=scope
    )
    try:
        while True:
            await websocket.receive_text()
            await realtime_manager.touch(connection_id, tenant_id=tenant_id)
    except WebSocketDisconnect:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)
    except Exception:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)
