"""Web Terminal WebSocket relay routes (Platform Expansion Phase 5).

Two endpoints — operator-facing and agent-facing — bridged by terminal_relay.
Both are gated by FEATURE_TERMINAL: with the flag off they accept-then-close
immediately (code 4003), so no terminal transport exists while the flag is off.

NPM already proxies these paths (host-wide websocket support on the
api-rdp.techi.com.al proxy host, verified 2026-07-10 — no separate route was
needed). The remaining gate to reachability is FEATURE_TERMINAL plus the
FEATURE_TERMINAL rollout scope enforced at session creation
(app/api/v1/endpoints/terminal.py, app/platform_core/rollout.py) — a session
can only exist for a device within scope, so these WS routes never see a
valid ticket otherwise.

Every disconnect (operator_closed / agent_gone) is logged and audited here;
idle-timeout / max-duration force-closes are logged and audited by
app.workers.terminal_watchdog, which owns that sweep so this module stays a
thin per-connection handler.
"""

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db.session import SessionLocal
from app.models.device import Device
from app.platform_core.flags import feature_enabled
from app.services.audit_service import AuditAction, system_audit_log
from app.services.notification_events import NotificationEvent
from app.services.notification_service import NotificationService
from app.services.terminal_relay import terminal_relay
from app.services.terminal_service import TerminalService

logger = logging.getLogger(__name__)

router = APIRouter()


async def _reject(ws: WebSocket, code: int) -> None:
    await ws.accept()
    await ws.close(code=code)


def _device_context(db, device_id: int):
    device = db.query(Device).filter(Device.id == device_id).first()
    hostname = device.hostname if device else f"device-{device_id}"
    client_id = getattr(device, "client_id", None) if device else None
    return hostname, client_id


def _notify_session_started(db, session) -> None:
    hostname, client_id = _device_context(db, session.device_id)
    NotificationService(db).dispatch(
        event_type=NotificationEvent.TERMINAL_SESSION_STARTED,
        title=f"Terminal session started on {hostname}",
        message=f"{session.operator_username or 'An operator'} opened a terminal session on {hostname}.",
        severity="info",
        device_id=session.device_id,
        client_id=client_id,
        payload={"session_id": session.id},
    )


def _notify_session_ended(db, session, reason: str) -> None:
    hostname, client_id = _device_context(db, session.device_id)
    NotificationService(db).dispatch(
        event_type=NotificationEvent.TERMINAL_SESSION_ENDED,
        title=f"Terminal session ended on {hostname}",
        message=f"Session on {hostname} ended ({reason}), duration {session.duration_seconds}s.",
        severity="info",
        device_id=session.device_id,
        client_id=client_id,
        payload={"session_id": session.id, "reason": reason},
    )


def _audit_session_end(db, session, reason: str) -> None:
    # Embedded SSH Connect sessions (mode="ssh") get their own audit action —
    # same call site, same details shape, just a distinct trail from the
    # Linux-agent PTY sessions this route was originally built for.
    action = (
        AuditAction.SSH_SESSION_ENDED
        if getattr(session, "mode", "agent") == "ssh"
        else AuditAction.TERMINAL_SESSION_CLOSED
    )
    system_audit_log(
        db,
        action=action,
        entity_type="terminal_session",
        entity_id=None,
        details={
            "session_id": session.id,
            "device_id": session.device_id,
            "operator_username": session.operator_username,
            "reason": reason,
            "duration_seconds": session.duration_seconds,
        },
    )
    _notify_session_ended(db, session, reason)


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
            logger.info("terminal operator WS rejected: session_id=%s (invalid/expired ticket)", session_id)
            await _reject(websocket, 4001)
            return
        await websocket.accept()
        logger.info("terminal operator WS attached: session_id=%s device_id=%s", session_id, session.device_id)
        pair = await terminal_relay.attach_operator(session_id, websocket)
        if pair.agent is not None:
            svc.mark_active(session)
            _notify_session_started(db, session)
        try:
            await terminal_relay.pump(session_id, websocket, is_operator=True)
        except WebSocketDisconnect:
            pass
        finally:
            session = svc.get(session_id) or session
            svc.close(session, "operator_closed")
            await terminal_relay.close(session_id)
            logger.info("terminal operator WS closed: session_id=%s reason=operator_closed", session_id)
            _audit_session_end(db, session, "operator_closed")
    except Exception:
        logger.exception("terminal operator WS error: session_id=%s", session_id)
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
            logger.info("terminal agent WS rejected: session_id=%s (invalid/expired ticket)", session_id)
            await _reject(websocket, 4001)
            return
        await websocket.accept()
        logger.info("terminal agent WS attached: session_id=%s device_id=%s", session_id, session.device_id)
        pair = await terminal_relay.attach_agent(session_id, websocket)
        if pair.operator is not None:
            svc.mark_active(session)
            _notify_session_started(db, session)
        try:
            await terminal_relay.pump(session_id, websocket, is_operator=False)
        except WebSocketDisconnect:
            pass
        finally:
            session = svc.get(session_id) or session
            svc.close(session, "agent_gone")
            await terminal_relay.close(session_id)
            logger.info("terminal agent WS closed: session_id=%s reason=agent_gone", session_id)
            _audit_session_end(db, session, "agent_gone")
    except Exception:
        logger.exception("terminal agent WS error: session_id=%s", session_id)
    finally:
        db.close()
