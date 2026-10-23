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

import json
import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import (
    ROLE_ORDER,
    get_operator_permissions,
    require_min_role,
    require_role_or_permission,
)
from app.core.config import settings
from app.services.action_push import push_action_if_connected
from app.db.session import get_db
from app.models.client import Client
from app.models.operator import Operator, OperatorRole
from app.platform_core.connect import methods_for
from app.platform_core.flags import feature_enabled
from app.platform_core.registry import resolve_platform
from app.platform_core.rollout import is_device_in_rollout
from app.repositories.device_repository import DeviceRepository
from app.schemas.remote_action import ActionType, RemoteActionCreate
from app.services.audit_service import AuditAction, audit_log
from app.services.remote_action_service import RemoteActionService
from app.services.ssh_connector import dial_and_run, ssh_connector_runner
from app.services.terminal_relay import terminal_relay
from app.services.terminal_service import TerminalService
from app.services.permission_service import TERMINAL_OPEN, TERMINAL_VIEW, VAULT_USE
from app.services.vault_service import VaultService

logger = logging.getLogger(__name__)

router = APIRouter()

# Terminal is a powerful capability — admin+ for now (a dedicated permission
# joins the matrix in Phase 6 IAM).
_require_admin = require_min_role(OperatorRole.ADMIN.value)


class TerminalSessionCreate(BaseModel):
    engine: str = "bash"
    # Administrator PowerShell (Windows) and the root terminal (Linux): a
    # current two-factor code, asked for every time a session is opened.
    mfa_code: Optional[str] = None


class TerminalSessionResponse(BaseModel):
    session_id: str
    operator_ws_path: str
    operator_ticket: str
    expires_in_seconds: int
    # "console": the live console over a socket. "command": Windows without a
    # pseudo console (Server 2012 R2 / 2016); each command runs on its own.
    mode: str = "console"


def _ws_base() -> str:
    base = (settings.PUBLIC_BACKEND_URL or "https://api-rdp.techi.com.al").rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):]
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):]
    return base


def _platform_id(device) -> str:
    descriptor = resolve_platform(device.platform)
    return descriptor.id if descriptor is not None else "windows"


def _is_windows(device) -> bool:
    return _platform_id(device) == "windows"


def _command_mode_device(device) -> bool:
    """A Windows agent without a pseudo console: PowerShell in command mode."""
    caps = device.capabilities if isinstance(device.capabilities, dict) else {}
    return _is_windows(device) and "powershell" not in caps and bool(getattr(device, "agent_id", None))


def _has_terminal_capability(device) -> bool:
    caps = device.capabilities or {}
    if not isinstance(caps, dict):
        return False
    # Windows agents from 2.1.29 open an administrator PowerShell console.
    return "terminal" in caps or (_is_windows(device) and "powershell" in caps)


_CONSOLE_NAME = {"powershell": "an administrator PowerShell", "bash": "a root terminal", "sh": "a root terminal"}


def _require_console_step_up(
    db: Session, operator: Operator, device_id: int, code: Optional[str], engine: str = "powershell",
) -> None:
    """A console with full rights on the device (PowerShell as SYSTEM on
    Windows, a root shell on Linux): the operator proves it is them again with
    a two-factor code, whatever their session says."""
    from app.services.mfa_service import MfaService

    reason = None
    if not operator.mfa_enabled:
        reason = "mfa_not_enabled"
    elif not (code or "").strip() or MfaService(db).verify(operator, code.strip().replace(" ", "")) is None:
        reason = "mfa_invalid"
    if reason is None:
        return
    audit_log(db, operator=operator, action=AuditAction.TERMINAL_SESSION_DENIED, entity_type="device",
              entity_id=device_id, details={"reason": reason, "engine": engine})
    console = _CONSOLE_NAME.get(engine, "a console")
    detail = (
        f"Turn on two-factor authentication to open {console}."
        if reason == "mfa_not_enabled" else f"Enter a current two-factor code to open {console}."
    )
    raise HTTPException(status_code=403, detail={"code": reason, "detail": detail})


# The push helper is shared with the other single-device action endpoints.
_push_action_if_connected = push_action_if_connected


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
    command_mode = _command_mode_device(device)
    if not _has_terminal_capability(device) and not command_mode:
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

    engine = payload.engine
    platform_id = _platform_id(device)
    if platform_id == "windows":
        # Whatever the caller asked for, a Windows device opens PowerShell —
        # and only after the two-factor check.
        engine = "powershell"
        _require_console_step_up(db, operator, device_id, payload.mfa_code, engine)
    elif platform_id == "linux":
        # The Linux console is a root shell: the same two-factor step and
        # recording as the Windows administrator PowerShell.
        engine = engine if engine in ("bash", "sh") else "bash"
        _require_console_step_up(db, operator, device_id, payload.mfa_code, engine)

    svc = TerminalService(db)
    if command_mode:
        return _open_command_mode(db, svc, device, operator)
    session, operator_ticket, agent_ticket = svc.create_session(
        device_id=device_id,
        operator_id=operator.id,
        operator_username=operator.username,
        engine=engine,
    )

    # Tell the agent to dial the terminal WS (delivered via heartbeat
    # pending_actions — reuses the existing command path; no new persistent
    # connection). ws_url routes through the same api-rdp host NPM already
    # proxies for /ws/devices (verified 2026-07-10: NPM's websocket support
    # is host-wide, not path-scoped — no separate NPM route was needed).
    ws_base = _ws_base()
    # The action deadline has to match the ticket: the agent only sees this on
    # its next heartbeat, so a flat 60s expired the action before it was ever
    # delivered (device 729: three attempts expired with sent_at NULL). Same
    # derivation as the ticket so the two can never drift apart.
    action_timeout = svc.ticket_ttl_for_device(device_id)
    try:
        action_svc = RemoteActionService(db)
        action = action_svc.queue_action(
            device_id,
            RemoteActionCreate(
                action_type=ActionType.OPEN_TERMINAL,
                parameters={
                    "session_id": session.id,
                    "ws_url": f"{ws_base}/ws/agent/terminal/{session.id}?ticket={agent_ticket}",
                    "engine": session.engine,
                },
                created_by=operator.username,
                execution_timeout_seconds=action_timeout,
            ),
        )
        # Push it now if the agent is holding a command channel open, so the
        # terminal opens in under a second instead of waiting out a heartbeat.
        # Strictly an accelerator: the action is already persisted, and an
        # agent that is not connected is served by the heartbeat path exactly
        # as before.
        _push_action_if_connected(device_id, action, action_svc)
    except ValueError as exc:
        # An open_terminal is already queued for this device. That is a
        # legitimate conflict, not a server fault: returning 500 with a raw
        # ValueError put the UI into a retry loop and hid the real reason from
        # the operator (observed 2026-08-04, two retries two seconds apart).
        svc.close(session, "duplicate open_terminal")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

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
        expires_in_seconds=svc.ticket_ttl_for_device(device_id),
    )


# ── PowerShell in command mode (app/services/powershell_command_mode.py) ──

def _open_command_mode(db: Session, svc: TerminalService, device, operator: Operator) -> TerminalSessionResponse:
    from app.models.device import DeviceStatus
    from app.services import powershell_command_mode as cmd

    if device.status != DeviceStatus.ONLINE:
        raise HTTPException(status_code=409, detail="The device is offline: PowerShell needs it online")
    cmd.close_stale(db, device.id)
    session, _, _ = svc.create_session(
        device_id=device.id, operator_id=operator.id, operator_username=operator.username, engine="powershell",
    )
    cmd.open_session(db, session, operator_username=operator.username,
                     device_name=(device.display_name or "").strip() or device.hostname or f"Device #{device.id}",
                     os_caption=device.os_caption)
    logger.info("terminal session opened: session_id=%s device_id=%s operator=%s engine=powershell mode=command",
                session.id, device.id, operator.username)
    audit_log(db, operator=operator, action=AuditAction.TERMINAL_SESSION_OPENED, entity_type="terminal_session",
              entity_id=None, details={"session_id": session.id, "device_id": device.id, "engine": "powershell",
                                       "mode": "command"})
    return TerminalSessionResponse(session_id=session.id, operator_ws_path="", operator_ticket="",
                                   expires_in_seconds=cmd.SESSION_MAX_SECONDS, mode="command")


class CommandModeRun(BaseModel):
    command: str = Field(min_length=1, max_length=20000)
    # The folder the previous command ended in; the next one starts there.
    cwd: Optional[str] = Field(default=None, max_length=1024)
    timeout_seconds: int = Field(default=120, ge=5, le=300)


class CommandModeQueued(BaseModel):
    action_id: int


class CommandModeResult(BaseModel):
    action_id: int
    status: str
    done: bool
    output: str = ""
    stderr: Optional[str] = None
    error: Optional[str] = None
    failed: Optional[bool] = None
    duration_ms: Optional[int] = None
    cwd: Optional[str] = None
    truncated: bool = False


def _command_mode_call(fn):
    from app.services.powershell_command_mode import CommandModeError

    try:
        return fn()
    except CommandModeError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)


@router.post("/devices/{device_id}/terminal/sessions/{session_id}/commands", response_model=CommandModeQueued)
def run_command_mode(
    device_id: int,
    session_id: str,
    payload: CommandModeRun,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    """One command in the caller's command-mode session: queued as a
    run_powershell action and pushed over the live channel."""
    from app.services import powershell_command_mode as cmd

    def go():
        session = cmd.get_session(db, device_id, session_id, operator.id)
        action = cmd.run_command(db, session, command=payload.command, cwd=payload.cwd,
                                 timeout_seconds=payload.timeout_seconds, operator_username=operator.username)
        return CommandModeQueued(action_id=action.id)

    return _command_mode_call(go)


@router.get("/devices/{device_id}/terminal/sessions/{session_id}/commands/{action_id}",
            response_model=CommandModeResult)
def command_mode_result(
    device_id: int,
    session_id: str,
    action_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    from app.models.terminal_session import TerminalSession
    from app.services import powershell_command_mode as cmd

    def go():
        session = db.get(TerminalSession, session_id)
        # A result is still readable after the session ended (the last command).
        if session is None or session.device_id != device_id or session.mode != cmd.MODE \
                or session.operator_id != operator.id:
            raise cmd.CommandModeError(404, "No command-mode session of yours on this device")
        return CommandModeResult(**cmd.command_result(db, session, action_id))

    return _command_mode_call(go)


@router.post("/devices/{device_id}/terminal/sessions/{session_id}/close", status_code=204)
def close_command_mode(
    device_id: int,
    session_id: str,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    from app.models.terminal_session import TerminalSession
    from app.services import powershell_command_mode as cmd

    session = db.get(TerminalSession, session_id)
    if session is None or session.device_id != device_id or session.mode != cmd.MODE or session.operator_id != operator.id:
        raise HTTPException(status_code=404, detail="No command-mode session of yours on this device")
    if cmd.close_session(db, session):
        audit_log(db, operator=operator, action=AuditAction.TERMINAL_SESSION_CLOSED, entity_type="terminal_session",
                  entity_id=None, details={"session_id": session.id, "device_id": device_id, "mode": "command",
                                           "reason": "operator_closed"})


class TerminalSessionSummary(BaseModel):
    session_id: str
    engine: str
    operator_username: Optional[str] = None
    status: str
    created_at: datetime
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    disconnect_reason: Optional[str] = None
    recording_bytes: Optional[int] = None
    mode: str = "agent"  # agent: the live console · command: command mode


@router.get("/devices/{device_id}/terminal/sessions", response_model=List[TerminalSessionSummary])
def list_terminal_sessions(
    device_id: int,
    limit: int = 20,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    """The device's recent console sessions, newest first, with the size of
    each recording (None when there is none)."""
    from app.models.terminal_session import TerminalSession
    from app.services.terminal_recording import recording_path

    if DeviceRepository(db).get(device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    from app.services.powershell_command_mode import close_stale

    close_stale(db, device_id)
    rows = (
        db.query(TerminalSession)
        .filter(TerminalSession.device_id == device_id, TerminalSession.mode.in_(("agent", "command")))
        .order_by(TerminalSession.created_at.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )
    out = []
    for s in rows:
        path = recording_path(s.id) if s.recording_path else None
        size = path.stat().st_size if path is not None and path.is_file() else None
        out.append(TerminalSessionSummary(
            session_id=s.id, engine=s.engine, operator_username=s.operator_username, status=s.status,
            created_at=s.created_at, started_at=s.started_at, ended_at=s.ended_at,
            disconnect_reason=s.disconnect_reason, recording_bytes=size, mode=s.mode,
        ))
    return out


@router.get("/devices/{device_id}/terminal/sessions/{session_id}/recording")
def get_terminal_recording(
    device_id: int,
    session_id: str,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    """The asciicast recording of an administrator console session (PowerShell or the Linux root shell)."""
    from fastapi.responses import FileResponse

    from app.models.terminal_session import TerminalSession
    from app.services.terminal_recording import recording_path

    session = db.get(TerminalSession, session_id)
    path = recording_path(session_id)
    if session is None or session.device_id != device_id or path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Recording not found")
    audit_log(db, operator=operator, action=AuditAction.TERMINAL_RECORDING_VIEWED, entity_type="terminal_session",
              entity_id=None, details={"session_id": session_id, "device_id": device_id})
    return FileResponse(path, media_type="application/x-asciicast", filename=f"powershell-{session_id}.cast")


# ─────────────────────────────────────────────────────────────────────────
# Embedded SSH Connect — reuses everything above (TerminalSession, ticket
# model, /ws/terminal/{id} route, TerminalRelay, TerminalWatchdog, audit call
# sites). The only new transport is app.services.ssh_connector, which attaches
# the backend's own SSH connection as the "agent" leg instead of an agent
# dialing in over a websocket. See docs/reference/OPERATOR-MANUAL.md and
# IMPLEMENTATION-ROADMAP.md ("Embedded SSH for connector platforms") for the
# architecture this implements.
# ─────────────────────────────────────────────────────────────────────────

_require_ssh_open = require_role_or_permission(OperatorRole.ADMIN.value, TERMINAL_OPEN)
_require_ssh_view = require_role_or_permission(OperatorRole.OPERATOR.value, TERMINAL_VIEW)


class SSHCredentialCandidateOut(BaseModel):
    id: int
    name: str
    username: Optional[str] = None
    credential_type: str


class SSHCredentialsResponse(BaseModel):
    tier: str  # device|group|client|global|none
    candidates: List[SSHCredentialCandidateOut]


class SSHSessionCreate(BaseModel):
    credential_id: Optional[int] = None
    # Ad hoc, operator-entered credentials — only used when the operator
    # explicitly chooses "Temporary Session" in the UI. Never persisted to
    # the Vault, never logged; used once to dial and then discarded.
    temporary_username: Optional[str] = None
    temporary_password: Optional[str] = None


class SSHSessionResponse(BaseModel):
    session_id: str
    operator_ws_path: str
    operator_ticket: str
    expires_in_seconds: int
    ssh_username: str
    credential_source: str  # device|group|client|global|temporary


class SSHSessionDetailResponse(BaseModel):
    """Feeds the Drawer's SSH session info panel: device, client, operator,
    username, authentication source, start, duration, idle timer, status."""

    session_id: str
    device_id: int
    device_hostname: Optional[str] = None
    client_id: Optional[int] = None
    client_name: Optional[str] = None
    operator_username: Optional[str] = None
    ssh_username: Optional[str] = None
    credential_source: Optional[str] = None
    status: str
    created_at: datetime
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    duration_seconds: int
    idle_seconds: Optional[float] = None
    disconnect_reason: Optional[str] = None


def _ssh_method_available(device) -> bool:
    """Reuses the Connect Framework registry (never a hardcoded platform
    check) to decide whether a device exposes an 'ssh' connect method."""
    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    return any(m.id == "ssh" for m in methods_for(platform_id, device.capabilities))


@router.get("/devices/{device_id}/ssh/credentials", response_model=SSHCredentialsResponse)
def ssh_credential_candidates(
    device_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_ssh_open),
):
    """Step 1 of Embedded SSH Connect: resolve Credential Vault candidates
    for this device, precedence Device > Group > Client > Global
    (VaultService.resolve_ssh_candidates). The frontend uses this to decide
    whether to auto-connect (exactly one candidate), show a selector (more
    than one), or show "no SSH credential available" (none) — it never falls
    back to asking for a password unless the operator explicitly picks
    Temporary Session."""
    # Step 1 of a flow that step 2 refuses while FEATURE_SSH is off; offering
    # a credential picker for it would be misleading.
    if not feature_enabled("FEATURE_SSH"):
        raise HTTPException(status_code=404, detail="Not Found")
    if not feature_enabled("FEATURE_TERMINAL"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    tier, candidates = VaultService(db).resolve_ssh_candidates(device)
    return SSHCredentialsResponse(
        tier=tier,
        candidates=[
            SSHCredentialCandidateOut(id=c.id, name=c.name, username=c.username, credential_type=c.credential_type)
            for c in candidates
        ],
    )


@router.post("/devices/{device_id}/ssh/sessions", response_model=SSHSessionResponse)
def create_ssh_session(
    device_id: int,
    payload: SSHSessionCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_ssh_open),
):
    """Step 2: resolve/validate the credential, create the session (same
    TerminalSession table, `mode="ssh"`), and schedule the backend's own SSH
    dial as the agent leg of the SAME relay pair the operator's browser
    already connects to via the existing /ws/terminal/{id} route."""
    if not feature_enabled("FEATURE_TERMINAL"):
        raise HTTPException(status_code=404, detail="Not Found")
    # Gated independently of the Connect menu so the route cannot be driven
    # directly while the menu reports it unavailable (RISK-SSH-001).
    if not feature_enabled("FEATURE_SSH"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if not _ssh_method_available(device):
        raise HTTPException(status_code=400, detail="Device does not expose an SSH connect method")
    if not is_device_in_rollout("FEATURE_TERMINAL", device):
        audit_log(
            db,
            operator=operator,
            action=AuditAction.TERMINAL_SESSION_DENIED,
            entity_type="device",
            entity_id=device_id,
            details={"reason": "outside_rollout_scope", "mode": "ssh"},
        )
        raise HTTPException(status_code=403, detail="Terminal is not yet enabled for this device (rollout scope)")

    host = device.local_ip or device.public_ip
    if not host:
        raise HTTPException(status_code=409, detail="Device has no known IP address yet")

    vault = VaultService(db)
    port = 22
    private_key: Optional[str] = None
    passphrase: Optional[str] = None
    vault_credential_id: Optional[int] = None

    if payload.temporary_username and payload.temporary_password:
        ssh_username = payload.temporary_username
        password: Optional[str] = payload.temporary_password
        credential_source = "temporary"
    else:
        tier, candidates = vault.resolve_ssh_candidates(device)
        if payload.credential_id is not None:
            credential = next((c for c in candidates if c.id == payload.credential_id), None)
            if credential is None:
                raise HTTPException(status_code=404, detail="Credential not available for this device")
        elif len(candidates) == 1:
            credential = candidates[0]
        elif len(candidates) == 0:
            audit_log(
                db,
                operator=operator,
                action=AuditAction.SSH_CREDENTIAL_MISSING,
                entity_type="device",
                entity_id=device_id,
                details={"reason": "no_ssh_credential"},
            )
            raise HTTPException(
                status_code=409,
                detail=(
                    "No SSH credential is available for this device. Add one in the Credential Vault "
                    "(Device, Group, Client, or Global scope), or start a Temporary Session."
                ),
            )
        else:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{len(candidates)} SSH credentials are available for this device — "
                    f"choose one via GET /devices/{device_id}/ssh/credentials"
                ),
            )

        # Consuming a stored Vault credential requires vault_use, additive on
        # top of admin+ (same shape as vault.py's _vault_gate) — a Temporary
        # Session never touches the Vault so it doesn't need this check.
        if ROLE_ORDER.get(operator.role, -1) < ROLE_ORDER.get(OperatorRole.ADMIN.value, 99):
            perms = get_operator_permissions(operator, db)
            if perms is None or VAULT_USE not in perms:
                raise HTTPException(status_code=403, detail=f"Permission denied: {VAULT_USE}")

        secret_fields = vault.get_secret_fields_for_use(credential)
        password = secret_fields.get("password")
        private_key = secret_fields.get("private_key")
        # Legacy ssh_key credentials store the private key under "secret"
        # (VaultService._decode_secret_payload's legacy fallback).
        if private_key is None and credential.credential_type == "ssh_key":
            private_key = secret_fields.get("secret")
        passphrase = secret_fields.get("passphrase")
        if not password and not private_key:
            raise HTTPException(status_code=409, detail="Credential has no usable secret")

        ssh_username = credential.username or ""
        if not ssh_username:
            raise HTTPException(status_code=409, detail="Credential has no username configured")

        metadata = json.loads(credential.metadata_json) if credential.metadata_json else {}
        try:
            port = int(metadata.get("port") or 22)
        except (TypeError, ValueError):
            port = 22

        vault_credential_id = credential.id
        credential_source = tier
        audit_log(
            db,
            operator=operator,
            action=AuditAction.SSH_CREDENTIAL_RESOLVED,
            entity_type="vault_credential",
            entity_id=credential.id,
            details={"device_id": device_id, "credential_source": tier},
        )

    svc = TerminalService(db)
    session, operator_ticket = svc.create_ssh_session(
        device_id=device_id,
        operator_id=operator.id,
        operator_username=operator.username,
        ssh_username=ssh_username,
        vault_credential_id=vault_credential_id,
        credential_source=credential_source,
    )

    ws_base = _ws_base()
    audit_log(
        db,
        operator=operator,
        action=AuditAction.SSH_SESSION_STARTED,
        entity_type="terminal_session",
        entity_id=None,
        details={
            "session_id": session.id,
            "device_id": device_id,
            "ssh_username": ssh_username,
            "credential_source": credential_source,
        },
    )

    ssh_connector_runner.schedule_threadsafe(
        dial_and_run(
            session.id,
            device_id,
            operator.username,
            host=host,
            port=port,
            username=ssh_username,
            password=password,
            private_key=private_key,
            passphrase=passphrase,
            vault_credential_id=vault_credential_id,
        )
    )

    return SSHSessionResponse(
        session_id=session.id,
        operator_ws_path=f"{ws_base}/ws/terminal/{session.id}?ticket={operator_ticket}",
        operator_ticket=operator_ticket,
        expires_in_seconds=svc.ticket_ttl_for_device(device_id),
        ssh_username=ssh_username,
        credential_source=credential_source,
    )


@router.get("/devices/{device_id}/ssh/sessions/{session_id}", response_model=SSHSessionDetailResponse)
def get_ssh_session(
    device_id: int,
    session_id: str,
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_ssh_view),
):
    """Feeds the Drawer's live session info panel and lets the frontend
    surface a precise failure reason (credential missing / host unreachable /
    authentication failed / timeout / host key mismatch / connection refused
    / network error) instead of a generic 'connection closed' message."""
    if not feature_enabled("FEATURE_TERMINAL"):
        raise HTTPException(status_code=404, detail="Not Found")

    svc = TerminalService(db)
    session = svc.get(session_id)
    if session is None or session.device_id != device_id:
        raise HTTPException(status_code=404, detail="Session not found")

    device = DeviceRepository(db).get(device_id)
    client = db.query(Client).filter(Client.id == device.client_id).first() if device and device.client_id else None

    return SSHSessionDetailResponse(
        session_id=session.id,
        device_id=session.device_id,
        device_hostname=device.hostname if device else None,
        client_id=device.client_id if device else None,
        client_name=client.name if client else None,
        operator_username=session.operator_username,
        ssh_username=session.ssh_username,
        credential_source=session.credential_source,
        status=session.status,
        created_at=session.created_at,
        started_at=session.started_at,
        ended_at=session.ended_at,
        duration_seconds=session.duration_seconds,
        idle_seconds=terminal_relay.idle_seconds(session.id),
        disconnect_reason=session.disconnect_reason,
    )
