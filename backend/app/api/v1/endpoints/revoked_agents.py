"""Agents the platform refuses (archived or deleted devices), and letting
one back in. The agent_id itself is a secret and never leaves the server."""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.core.auth import require_min_role
from app.db.session import get_db
from app.models.device import Device
from app.models.operator import Operator, OperatorRole
from app.models.revoked_agent import RevokedAgent
from app.services.audit_service import AuditAction, audit_log

router = APIRouter()

_require_admin = require_min_role(OperatorRole.ADMIN.value)


class RevokedAgentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: Optional[int] = None
    hostname: Optional[str] = None
    client_id: Optional[int] = None
    reason: Optional[str] = None
    revoked_at: datetime
    revoked_by: Optional[str] = None
    last_attempt_at: Optional[datetime] = None
    last_attempt_ip: Optional[str] = None
    attempt_count: int = 0
    # False once the device was purged: only "Allow back" brings it again.
    device_exists: bool = False


@router.get("", response_model=List[RevokedAgentOut])
def list_revoked_agents(db: Session = Depends(get_db), _: Operator = Depends(_require_admin)):
    rows = db.query(RevokedAgent).order_by(RevokedAgent.revoked_at.desc()).limit(500).all()
    ids = {r.device_id for r in rows if r.device_id}
    existing = {d for (d,) in db.query(Device.id).filter(Device.id.in_(ids))} if ids else set()
    out = []
    for row in rows:
        item = RevokedAgentOut.model_validate(row)
        item.device_exists = row.device_id in existing
        out.append(item)
    return out


@router.post("/{revoked_id}/allow", status_code=204)
def allow_agent_back(revoked_id: int, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    """Accept the agent again. With its device purged, its next heartbeat
    creates the device anew (no client until placed)."""
    row = db.get(RevokedAgent, revoked_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    details = {"hostname": row.hostname, "device_id": row.device_id}
    db.delete(row)
    db.commit()
    audit_log(db, operator=operator, action=AuditAction.AGENT_ALLOWED_BACK, entity_type="device",
              entity_id=details["device_id"], details=details)
