"""PowerShell in command mode, for Windows without a pseudo console.

The administrator console (terminal_windows.go in the agent) needs ConPTY,
which exists from Windows 10 1809 / Server 2019. Server 2012 R2 and 2016 do
not have it, so their agents never report the "powershell" capability. They
still run `run_powershell` (a plain powershell.exe, its output returned), so
the same console opens there in command mode: the operator types a command,
the agent runs it, the output comes back. Same two-factor step, same admin
role, same recording and history as the full console; no agent change.

What it cannot do: answer a prompt while a command runs, Tab completion, or
stop a running command (the agent's own timeout does, at most 5 minutes).
Each command is a new PowerShell process: the current directory is carried
from one command to the next, variables are not. The agent returns at most
~4,000 characters of output per command.

Nothing here runs on the heartbeat path; each command is one remote action.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow
from app.models.remote_action import ActionStatus, RemoteAction, TERMINAL_STATUSES
from app.models.terminal_session import TerminalSession, TerminalSessionStatus
from app.services.terminal_recording import RECORDING_MAX_BYTES, recording_path

logger = logging.getLogger(__name__)

MODE = "command"
ACTION_TYPE = "run_powershell"
IDLE_TIMEOUT_SECONDS = 15 * 60
SESSION_MAX_SECONDS = 60 * 60
DEFAULT_TIMEOUT_SECONDS = 120
MAX_TIMEOUT_SECONDS = 300  # the agent caps run_powershell at 300 s
# The first line of every result: "<marker> <failed 0|1> <ms> <location>". It
# leads the output so the agent's 4,096-character cut never takes it away.
END_MARKER = "__TECHI_CMD__"
_MARKER_LINE = re.compile(rf"^{END_MARKER} ([01]) (\d+) ?(.*)$")
# Marks an action whose result is already in the recording (the column is
# otherwise used only for self-update progress).
RECORDED_STAGE = "recorded"
# Where powershell.exe starts as the agent's service account.
DEFAULT_CWD = "C:\\Windows\\system32"


class CommandModeError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _ps_literal(text: str) -> str:
    return "'" + (text or "").replace("'", "''") + "'"


def build_script(command: str, cwd: Optional[str]) -> str:
    """The command as one PowerShell run: in the carried directory, errors in
    the output, a wide table format, and the marker line first."""
    return "\n".join([
        "$ProgressPreference = 'SilentlyContinue'",
        "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}",
        f"$__techiCwd = {_ps_literal(cwd or '')}",
        "if ($__techiCwd) { Set-Location -LiteralPath $__techiCwd -ErrorAction SilentlyContinue }",
        "$__techiErrors = $Error.Count",
        "$global:LASTEXITCODE = 0",
        "$__techiStart = Get-Date",
        "$__techiOut = . {",
        command,
        "} 2>&1 | Out-String -Width 160",
        "$__techiFailed = 0",
        "if ($Error.Count -gt $__techiErrors -or ($LASTEXITCODE -and $LASTEXITCODE -ne 0)) { $__techiFailed = 1 }",
        "$__techiMs = [int]((Get-Date) - $__techiStart).TotalMilliseconds",
        f"\"{END_MARKER} $__techiFailed $__techiMs $((Get-Location).Path)\"",
        "$__techiOut",
        "exit 0",
    ])


def parse_output(raw: Optional[str]) -> Tuple[str, Optional[bool], Optional[int], Optional[str]]:
    """(output, failed, duration_ms, location) from what the agent returned."""
    text = (raw or "").replace("\r\n", "\n")
    lines = text.split("\n")
    for i, line in enumerate(lines[:5]):
        match = _MARKER_LINE.match(line.strip())
        if match:
            rest = "\n".join(lines[:i] + lines[i + 1:]).strip("\n")
            location = match.group(3).strip() or None
            return rest, match.group(1) == "1", int(match.group(2)), location
    return text.strip("\n"), None, None, None


# ── recording (asciicast v2, the same file the full console writes) ─────────

def _offset(session: TerminalSession) -> float:
    started = ensure_utc(session.started_at or session.created_at)
    return round(max(0.0, (ensure_utc(utcnow()) - started).total_seconds()), 3)


def record(session: TerminalSession, text: str, *, header: bool = False, title: str = "") -> None:
    path = recording_path(session.id)
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file() and path.stat().st_size > RECORDING_MAX_BYTES:
            return
        with open(path, "a", encoding="utf-8") as handle:
            if header:
                handle.write(json.dumps({
                    "version": 2, "width": 160, "height": 30,
                    "timestamp": int(ensure_utc(session.started_at or utcnow()).timestamp()),
                    "title": title[:200], "env": {"SHELL": "powershell", "TERM": "xterm-256color"},
                }) + "\n")
            if text:
                handle.write(json.dumps([_offset(session), "o", text.replace("\r\n", "\n").replace("\n", "\r\n")],
                                        ensure_ascii=False) + "\n")
    except OSError:
        logger.exception("command mode: cannot write the recording of %s", session.id)


def last_activity(session: TerminalSession) -> datetime:
    """The last write to the recording (a command or its output), else the start."""
    started = ensure_utc(session.started_at or session.created_at)
    path = recording_path(session.id)
    try:
        if path is not None and path.is_file():
            from datetime import timezone

            return max(started, datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc))
    except OSError:
        pass
    return started


# ── sessions ────────────────────────────────────────────────────────────────

def open_session(db: Session, session: TerminalSession, *, operator_username: str, device_name: str,
                 os_caption: Optional[str]) -> None:
    """A command-mode session is live as soon as it exists: no socket to wait for."""
    session.mode = MODE
    session.status = TerminalSessionStatus.ACTIVE.value
    session.started_at = utcnow()
    session.recording_path = f"{session.id}.cast"
    db.commit()
    db.refresh(session)
    record(
        session,
        f"Session started by {operator_username} after a 2FA code · {os_caption or 'Windows'} · command mode "
        "(no pseudo console on this Windows: each command runs on its own, the folder is kept)\n",
        header=True, title=f"{device_name} · PowerShell (command mode)",
    )


def close_stale(db: Session, device_id: int, now: Optional[datetime] = None) -> int:
    """Command-mode sessions nobody closed (the window was shut): end them
    once idle or past the hour, so the history tells the truth."""
    now = ensure_utc(now or utcnow())
    rows = (
        db.query(TerminalSession)
        .filter(TerminalSession.device_id == device_id, TerminalSession.mode == MODE,
                TerminalSession.status == TerminalSessionStatus.ACTIVE.value)
        .limit(50)
        .all()
    )
    closed = 0
    for session in rows:
        reason = _limit_reached(session, now)
        if reason:
            _close(db, session, reason)
            closed += 1
    return closed


def _limit_reached(session: TerminalSession, now: datetime) -> Optional[str]:
    started = ensure_utc(session.started_at or session.created_at)
    if (now - started).total_seconds() > SESSION_MAX_SECONDS:
        return "max_duration"
    if (now - last_activity(session)).total_seconds() > IDLE_TIMEOUT_SECONDS:
        return "idle_timeout"
    return None


def _close(db: Session, session: TerminalSession, reason: str) -> bool:
    from app.services.terminal_service import TerminalService

    ended = TerminalService(db).close(session, reason)
    if ended:
        record(session, f"\nSession ended ({reason.replace('_', ' ')})\n")
    return ended


def get_session(db: Session, device_id: int, session_id: str, operator_id: int) -> TerminalSession:
    """The caller's own open command-mode session on this device, or an error
    that says why it cannot take a command."""
    session = db.get(TerminalSession, session_id)
    if session is None or session.device_id != device_id or session.mode != MODE or session.operator_id != operator_id:
        raise CommandModeError(404, "No command-mode session of yours on this device")
    if session.status != TerminalSessionStatus.ACTIVE.value:
        raise CommandModeError(410, "The session has ended")
    reason = _limit_reached(session, ensure_utc(utcnow()))
    if reason:
        _close(db, session, reason)
        raise CommandModeError(410, "The session closed: 15 minutes idle" if reason == "idle_timeout"
                               else "The session closed: one hour is the limit")
    return session


def close_session(db: Session, session: TerminalSession, reason: str = "operator_closed") -> bool:
    return _close(db, session, reason)


# ── commands ────────────────────────────────────────────────────────────────

def run_command(db: Session, session: TerminalSession, *, command: str, cwd: Optional[str],
                timeout_seconds: int, operator_username: str) -> RemoteAction:
    from app.services.action_push import push_action_if_connected
    from app.services.remote_action_service import RemoteActionService

    command = (command or "").strip("\r\n")
    if not command.strip():
        raise CommandModeError(422, "Type a command")
    busy = (
        db.query(RemoteAction.id)
        .filter(RemoteAction.device_id == session.device_id, RemoteAction.action_type == ACTION_TYPE,
                RemoteAction.status.notin_(list(TERMINAL_STATUSES)))
        .first()
    )
    if busy is not None:
        raise CommandModeError(409, "A command is still running on this device; wait for it to finish")
    timeout = max(5, min(int(timeout_seconds or DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS))
    now = utcnow()
    action = RemoteAction(
        device_id=session.device_id,
        action_type=ACTION_TYPE,
        payload=json.dumps({"script": build_script(command, cwd), "timeout_seconds": timeout,
                            "session_id": session.id}),
        status=ActionStatus.QUEUED,
        created_at=now,
        queued_at=now,
        created_by=operator_username,
        # Room for delivery and the callback beyond the agent's own timeout.
        execution_timeout_seconds=timeout + 60,
    )
    db.add(action)
    db.commit()
    db.refresh(action)
    record(session, f"PS {cwd or DEFAULT_CWD}> {command}\n")
    push_action_if_connected(session.device_id, action, RemoteActionService(db))
    return action


def command_result(db: Session, session: TerminalSession, action_id: int) -> Dict[str, Any]:
    action = db.get(RemoteAction, action_id)
    payload: Dict[str, Any] = {}
    if action is not None:
        try:
            payload = json.loads(action.payload or "{}")
        except ValueError:
            payload = {}
    if action is None or action.device_id != session.device_id or payload.get("session_id") != session.id:
        raise CommandModeError(404, "No such command in this session")
    status = getattr(action.status, "value", action.status)
    done = action.status in TERMINAL_STATUSES
    output, failed, duration_ms, location = parse_output(action.output)
    error = None
    if done and status != ActionStatus.COMPLETED.value:
        error = action.error_message or (
            "The device did not answer in time" if status == ActionStatus.EXPIRED.value else f"The command {status}"
        )
        failed = True
    stderr = (action.stderr_output or "").strip()
    if done and action.stage != RECORDED_STAGE:
        text = output
        if stderr:
            text = f"{text}\n{stderr}" if text else stderr
        if error:
            text = f"{text}\n{error}" if text else error
        record(session, (text + "\n") if text else "")
        action.stage = RECORDED_STAGE
        db.commit()
    return {
        "action_id": action.id, "status": status, "done": done, "output": output, "stderr": stderr or None,
        "error": error, "failed": failed, "duration_ms": duration_ms, "cwd": location,
        "truncated": "[truncated]" in (action.output or ""),
    }


__all__ = [
    "CommandModeError", "MODE", "build_script", "close_session", "close_stale", "command_result", "get_session",
    "open_session", "parse_output", "run_command",
]
