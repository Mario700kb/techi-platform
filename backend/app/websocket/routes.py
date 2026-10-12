from typing import Optional, Tuple, Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.security import JWTError, decode_access_token
from app.db.session import SessionLocal
from app.repositories.operator_repository import OperatorRepository
from app.websocket.manager import realtime_manager

router = APIRouter()

# Sentinel returned when WebSocket authentication fails.
_AUTH_FAILED = object()

# The dashboard authenticates with its HttpOnly session cookie, which the
# browser sends on the handshake. Older clients may instead offer the token
# as a subprotocol ("techi.auth.<jwt>") next to "techi.v1" — never in the
# URL, which lands in every proxy and server access log. The server answers
# with "techi.v1", which browsers require when protocols were offered.
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


def _origin_allowed(websocket: WebSocket) -> bool:
    """WebSockets have no CORS: without this a page on any site could open a
    socket that the browser authenticates with the operator's cookie."""
    from app.core.config import settings

    if settings.BACKEND_CORS_ALLOW_ALL:
        return True
    origin = websocket.headers.get("origin", "") if hasattr(websocket, "headers") else ""
    return origin.rstrip("/") in {allowed.rstrip("/") for allowed in settings.BACKEND_CORS_ORIGINS}


def _ws_token(websocket: WebSocket) -> Optional[str]:
    """The browser's session cookie, or — for older clients — a token offered
    as a subprotocol. A cookie only counts from an allowed Origin."""
    from app.services.session_service import ACCESS_COOKIE

    token = _token_from_subprotocols(websocket)
    if token:
        return token
    cookies = getattr(websocket, "cookies", None) or {}
    cookie_token = cookies.get(ACCESS_COOKIE)
    if cookie_token and _origin_allowed(websocket):
        return cookie_token
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
            if payload.get("purpose"):
                raise JWTError("not an access token")
            operator_id = int(payload.get("sub"))
        except (JWTError, TypeError, ValueError):
            await _reject_ws(websocket)
            return _AUTH_FAILED

        session_id = payload.get("sid")
        if session_id:
            from app.services.session_service import SessionService

            session = SessionService(db).get_live(session_id)
            if session is None or session.operator_id != operator_id:
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
    scope = await _authenticate_ws(websocket, _ws_token(websocket))
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
    scope = await _authenticate_ws(websocket, _ws_token(websocket))
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
