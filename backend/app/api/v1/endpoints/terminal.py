"""Web Terminal session API (Platform Expansion Phase 5, dark).

POST /devices/{id}/terminal/sessions creates a session, enqueues an
`open_terminal` action for the agent, and returns the operator WS URL + a
one-time ticket. Gated by FEATURE_TERMINAL (404 when off) AND by the device
reporting the `terminal` capability — the tab/endpoint simply doesn't exist
otherwise. Operator-scoped and audited; nothing here stores a device secret.
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
from app.repositories.device_repository import DeviceRepository
from app.schemas.remote_action import ActionType, RemoteActionCreate
from app.services.audit_service import audit_log
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

    svc = TerminalService(db)
    session, operator_ticket, agent_ticket = svc.create_session(
        device_id=device_id,
        operator_id=operator.id,
        operator_username=operator.username,
        engine=payload.engine,
    )

    # Tell the agent to dial the terminal WS (delivered via heartbeat
    # pending_actions — reuses the existing command path; no new persistent
    # connection). ws_url routes through the same api-rdp host once the NPM WS
    # route exists.
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

    audit_log(
        db,
        operator=operator,
        action="terminal_session_opened",
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
