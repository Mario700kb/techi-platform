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

# The dashboard sends its session token as a WebSocket subprotocol
# ("techi.auth.<jwt>") next to "techi.v1", never in the URL: a URL lands in
# every proxy and server access log, a subprotocol header does not. The
# server answers with "techi.v1", which browsers require when protocols
# were offered.
WS_SUBPROTOCOL = "techi.v1"
_AUTH_PREFIX = "techi.auth."


def _offered_subprotocols(websocket: WebSocket) -> list:
    raw = websocket.headers.get("sec-websocket-protocol", "") if hasattr(websocket, "headers") else ""
    return [item.strip() for item in raw.split(",") if item.strip()]


def _token_from_subprotocols(websocket: WebSocket) -> Optional[str]:
    for item in _offered_subprotocols(websocket):
        if item.startswith(_AUTH_PREFIX):
            return item[len(_AUTH_PREFIX):] or None
    return None


def _subprotocol_for(websocket: WebSocket) -> Optional[str]:
    return WS_SUBPROTOCOL if WS_SUBPROTOCOL in _offered_subprotocols(websocket) else None


async def _reject_ws(websocket: WebSocket) -> None:
    # Accept before closing so browsers receive the application close code
    # instead of a generic failed-handshake error and reconnect loop.
    subprotocol = _subprotocol_for(websocket)
    if subprotocol:
        await websocket.accept(subprotocol=subprotocol)
    else:
        await websocket.accept()
    await websocket.close(code=4001)


async def _authenticate_ws(websocket: WebSocket, token: Optional[str]) -> Any:
    """Validate JWT, resolve operator scope, and return it.

    Returns:
      - None if the operator is unrestricted (admin/owner — no scope filter).
      - An AllowedScope instance for operator/readonly accounts.
      - _AUTH_FAILED if the token is missing/invalid or the operator is inactive
        (the WebSocket is also closed with code 4001 in that case).
    """
    if not token:
        await _reject_ws(websocket)
        return _AUTH_FAILED

    db = SessionLocal()
    try:
        try:
            payload = decode_access_token(token)
            operator_id = int(payload.get("sub"))
        except (JWTError, TypeError, ValueError):
            await _reject_ws(websocket)
            return _AUTH_FAILED

        operator = OperatorRepository(db).get(operator_id)
        if operator is None or not operator.is_active:
            await _reject_ws(websocket)
            return _AUTH_FAILED

        from app.core.auth import is_unrestricted
        from app.services.team_service import TeamScopeService

        if is_unrestricted(operator):
            return None  # admin/owner: no restriction

        return TeamScopeService(db).get_team_scope_for_operator(operator.id)
    finally:
        db.close()


@router.websocket("/ws/devices")
async def devices_websocket(websocket: WebSocket, tenant_id: str = "default"):
    scope = await _authenticate_ws(websocket, _token_from_subprotocols(websocket))
    if scope is _AUTH_FAILED:
        return
    connection_id = await realtime_manager.connect(
        websocket, tenant_id=tenant_id, channel="devices", operator_scope=scope,
        subprotocol=_subprotocol_for(websocket),
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
async def deployments_websocket(websocket: WebSocket, tenant_id: str = "default"):
    scope = await _authenticate_ws(websocket, _token_from_subprotocols(websocket))
    if scope is _AUTH_FAILED:
        return
    connection_id = await realtime_manager.connect(
        websocket, tenant_id=tenant_id, channel="deployments", operator_scope=scope,
        subprotocol=_subprotocol_for(websocket),
    )
    try:
        while True:
            await websocket.receive_text()
            await realtime_manager.touch(connection_id, tenant_id=tenant_id)
    except WebSocketDisconnect:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)
    except Exception:
        await realtime_manager.disconnect(connection_id, tenant_id=tenant_id)
