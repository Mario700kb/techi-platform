"""Web Terminal WebSocket relay routes (Platform Expansion Phase 5, dark).

Two endpoints — operator-facing and agent-facing — bridged by terminal_relay.
Both are gated by FEATURE_TERMINAL: with the flag off they accept-then-close
immediately (code 4003), so no terminal transport exists in today's production.

No public NPM route is added here; these paths become reachable only once the
owner approves the edge WS route (STOP condition of Phase 5).
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db.session import SessionLocal
from app.platform_core.flags import feature_enabled
from app.services.terminal_relay import terminal_relay
from app.services.terminal_service import TerminalService

router = APIRouter()


async def _reject(ws: WebSocket, code: int) -> None:
    await ws.accept()
    await ws.close(code=code)


@router.websocket("/ws/terminal/{session_id}")
async def operator_terminal_ws(websocket: WebSocket, session_id: str, ticket: str = ""):
    if not feature_enabled("FEATURE_TERMINAL"):
        await _reject(websocket, 4003)
        return
    db = SessionLocal()
    try:
        svc = TerminalService(db)
        session = svc.verify_operator_ticket(session_id, ticket)
        if session is None:
            await _reject(websocket, 4001)
            return
        await websocket.accept()
        pair = await terminal_relay.attach_operator(session_id, websocket)
        if pair.agent is not None:
            svc.mark_active(session)
        try:
            await terminal_relay.pump(session_id, websocket, is_operator=True)
        except WebSocketDisconnect:
            pass
        finally:
            svc.close(svc.get(session_id) or session, "operator_closed")
            await terminal_relay.close(session_id)
    finally:
        db.close()


@router.websocket("/ws/agent/terminal/{session_id}")
async def agent_terminal_ws(websocket: WebSocket, session_id: str, ticket: str = ""):
    if not feature_enabled("FEATURE_TERMINAL"):
        await _reject(websocket, 4003)
        return
    db = SessionLocal()
    try:
        svc = TerminalService(db)
        session = svc.verify_agent_ticket(session_id, ticket)
        if session is None:
            await _reject(websocket, 4001)
            return
        await websocket.accept()
        pair = await terminal_relay.attach_agent(session_id, websocket)
        if pair.operator is not None:
            svc.mark_active(session)
        try:
            await terminal_relay.pump(session_id, websocket, is_operator=False)
        except WebSocketDisconnect:
            pass
        finally:
            svc.close(svc.get(session_id) or session, "agent_gone")
            await terminal_relay.close(session_id)
    finally:
        db.close()
