"""Saved PowerShell scripts for the administrator console.

An administrator keeps a library of scripts and runs one inside a console
session they have open on a Windows device. The platform hands back the line
to type into that console — the script travels base64-encoded so no quoting
or line editing can change it — and audits the run with the script's version
and a hash of its text. What the script prints is in the session recording.
"""
import base64
import hashlib
import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import require_min_role
from app.core.time import utcnow_naive
from app.db.session import get_db
from app.models.console_script import ConsoleScript
from app.models.operator import Operator, OperatorRole
from app.models.terminal_session import TerminalSession, TerminalSessionStatus
from app.services.audit_service import AuditAction, audit_log

logger = logging.getLogger(__name__)
router = APIRouter()
_require_admin = require_min_role(OperatorRole.ADMIN.value)

MAX_BODY = 10_000


class ConsoleScriptBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    body: str = Field(min_length=1, max_length=MAX_BODY)


class ConsoleScriptOut(ConsoleScriptBody):
    id: int
    version: int
    uses: int
    last_used_at: Optional[datetime] = None
    updated_by: Optional[str] = None
    updated_at: datetime

    model_config = {"from_attributes": True}


class ConsoleScriptRun(BaseModel):
    command: str
    script: ConsoleScriptOut


def _get(db: Session, script_id: int) -> ConsoleScript:
    script = db.get(ConsoleScript, script_id)
    if script is None:
        raise HTTPException(status_code=404, detail="Script not found")
    return script


def _clean(body: ConsoleScriptBody) -> ConsoleScriptBody:
    return ConsoleScriptBody(
        name=" ".join(body.name.split()),
        description=(body.description or "").strip() or None,
        body=body.body.replace("\r\n", "\n").strip("\n"),
    )


@router.get("/console/scripts", response_model=List[ConsoleScriptOut])
def list_scripts(db: Session = Depends(get_db), _: Operator = Depends(_require_admin)):
    return db.query(ConsoleScript).order_by(ConsoleScript.uses.desc(), ConsoleScript.name).all()


@router.post("/console/scripts", response_model=ConsoleScriptOut, status_code=201)
def create_script(body: ConsoleScriptBody, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    body = _clean(body)
    now = utcnow_naive()
    script = ConsoleScript(name=body.name, description=body.description, body=body.body, version=1, uses=0,
                           created_by=operator.username, updated_by=operator.username, created_at=now, updated_at=now)
    db.add(script)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A script with this name already exists")
    db.refresh(script)
    audit_log(db, operator=operator, action=AuditAction.CONSOLE_SCRIPT_CREATED, entity_type="console_script",
              entity_id=script.id, details={"name": script.name})
    return script


@router.put("/console/scripts/{script_id}", response_model=ConsoleScriptOut)
def update_script(script_id: int, body: ConsoleScriptBody, db: Session = Depends(get_db),
                  operator: Operator = Depends(_require_admin)):
    script = _get(db, script_id)
    body = _clean(body)
    changed = (script.name, script.description, script.body) != (body.name, body.description, body.body)
    if changed:
        script.name, script.description, script.body = body.name, body.description, body.body
        script.version += 1
        script.updated_by, script.updated_at = operator.username, utcnow_naive()
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="A script with this name already exists")
        db.refresh(script)
        audit_log(db, operator=operator, action=AuditAction.CONSOLE_SCRIPT_UPDATED, entity_type="console_script",
                  entity_id=script.id, details={"name": script.name, "version": script.version})
    return script


@router.delete("/console/scripts/{script_id}", status_code=204)
def delete_script(script_id: int, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    script = _get(db, script_id)
    name = script.name
    db.delete(script)
    db.commit()
    audit_log(db, operator=operator, action=AuditAction.CONSOLE_SCRIPT_DELETED, entity_type="console_script",
              entity_id=script_id, details={"name": name})


def console_command(script: ConsoleScript) -> str:
    """One line that runs the script as written, whatever it contains, and
    names it at the end so the recording says what ran."""
    encoded = base64.b64encode(script.body.encode("utf-8")).decode("ascii")
    label = "".join(ch for ch in script.name if ch.isprintable() and ch not in "\r\n")
    return (
        f"& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))))"
        f"  # TECHI script: {label} v{script.version}"
    )


@router.post("/devices/{device_id}/terminal/sessions/{session_id}/scripts/{script_id}", response_model=ConsoleScriptRun)
def run_script(device_id: int, session_id: str, script_id: int, db: Session = Depends(get_db),
               operator: Operator = Depends(_require_admin)):
    """Run a saved script in a console the caller has open on this device."""
    session = db.get(TerminalSession, session_id)
    open_states = {TerminalSessionStatus.PENDING.value, TerminalSessionStatus.ACTIVE.value}
    if (
        session is None or session.device_id != device_id or session.engine != "powershell"
        or session.operator_id != operator.id or session.status not in open_states
    ):
        raise HTTPException(status_code=404, detail="No open PowerShell session of yours on this device")
    script = _get(db, script_id)
    script.uses = (script.uses or 0) + 1
    script.last_used_at = utcnow_naive()
    db.commit()
    db.refresh(script)
    audit_log(db, operator=operator, action=AuditAction.CONSOLE_SCRIPT_RUN, entity_type="device", entity_id=device_id,
              details={"session_id": session_id, "script_id": script.id, "name": script.name,
                       "version": script.version, "sha256": hashlib.sha256(script.body.encode("utf-8")).hexdigest()})
    return ConsoleScriptRun(command=console_command(script), script=ConsoleScriptOut.model_validate(script))
