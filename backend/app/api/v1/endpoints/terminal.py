"""Web Terminal session API (Platform Expansion Phase 5).

POST /devices/{id}/terminal/sessions creates a session, enqueues an
`open_terminal` action for the agent, and returns the operator WS URL + a
one-time ticket. Gated by, in order: FEATURE_TERMINAL (404 when off), the
device reporting the `terminal` capability (400 otherwise — capability-driven,
not a platform check; only the Linux agent reports it today), and the
FEATURE_TERMINAL rollout scope (403 otherwise — see
app.platform_core.rollout, generic across future features). Operator-scoped
(admin+) and audited on both grant and denial; nothing here stores a device
secret.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_min_role
from app.core.config import settings
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.platform_core.flags import feature_enabled
from app.platform_core.rollout import is_device_in_rollout
from app.repositories.device_repository import DeviceRepository
from app.schemas.remote_action import ActionType, RemoteActionCreate
from app.services.audit_service import AuditAction, audit_log
from app.services.remote_action_service import RemoteActionService
from app.services.terminal_service import TerminalService, TICKET_TTL_SECONDS

logger = logging.getLogger(__name__)

router = APIRouter()

# Terminal is a powerful capability — admin+ for now (a dedicated permission
# joins the matrix in Phase 6 IAM).
_require_admin = require_min_role(OperatorRole.ADMIN.value)


class TerminalSessionCreate(BaseModel):
    engine: str = "bash"


class TerminalSessionResponse(BaseModel):
    session_id: str
    operator_ws_path: str
    operator_ticket: str
    expires_in_seconds: int


def _ws_base() -> str:
    base = (settings.PUBLIC_BACKEND_URL or "https://api-rdp.techi.com.al").rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):]
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):]
    return base


def _has_terminal_capability(device) -> bool:
    caps = device.capabilities or {}
    return isinstance(caps, dict) and "terminal" in caps


@router.post("/devices/{device_id}/terminal/sessions", response_model=TerminalSessionResponse)
def create_terminal_session(
    device_id: int,
    payload: TerminalSessionCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    if not feature_enabled("FEATURE_TERMINAL"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if not _has_terminal_capability(device):
        raise HTTPException(status_code=400, detail="Device does not report the terminal capability")
    if not is_device_in_rollout("FEATURE_TERMINAL", device):
        logger.info(
            "terminal session denied: device_id=%s operator=%s (not in FEATURE_TERMINAL rollout scope)",
            device_id, operator.username,
        )
        audit_log(
            db,
            operator=operator,
            action=AuditAction.TERMINAL_SESSION_DENIED,
            entity_type="device",
            entity_id=device_id,
            details={"reason": "outside_rollout_scope"},
        )
        raise HTTPException(status_code=403, detail="Terminal is not yet enabled for this device (rollout scope)")

    svc = TerminalService(db)
    session, operator_ticket, agent_ticket = svc.create_session(
        device_id=device_id,
        operator_id=operator.id,
        operator_username=operator.username,
        engine=payload.engine,
    )

    # Tell the agent to dial the terminal WS (delivered via heartbeat
    # pending_actions — reuses the existing command path; no new persistent
    # connection). ws_url routes through the same api-rdp host NPM already
    # proxies for /ws/devices (verified 2026-07-10: NPM's websocket support
    # is host-wide, not path-scoped — no separate NPM route was needed).
    ws_base = _ws_base()
    RemoteActionService(db).queue_action(
        device_id,
        RemoteActionCreate(
            action_type=ActionType.OPEN_TERMINAL,
            parameters={
                "session_id": session.id,
                "ws_url": f"{ws_base}/ws/agent/terminal/{session.id}?ticket={agent_ticket}",
                "engine": session.engine,
            },
            created_by=operator.username,
            execution_timeout_seconds=60,
        ),
    )

    logger.info(
        "terminal session opened: session_id=%s device_id=%s operator=%s engine=%s",
        session.id, device_id, operator.username, session.engine,
    )
    audit_log(
        db,
        operator=operator,
        action=AuditAction.TERMINAL_SESSION_OPENED,
        entity_type="terminal_session",
        entity_id=None,
        details={"session_id": session.id, "device_id": device_id, "engine": session.engine},
    )

    return TerminalSessionResponse(
        session_id=session.id,
        operator_ws_path=f"{ws_base}/ws/terminal/{session.id}?ticket={operator_ticket}",
        operator_ticket=operator_ticket,
        expires_in_seconds=TICKET_TTL_SECONDS,
    )
