from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.repositories.audit_log_repository import AuditLogRepository
from app.schemas.audit_log import AuditLogOut, AuditLogPage

router = APIRouter()


@router.get("", response_model=AuditLogPage)
def list_audit_logs(
    db: Session = Depends(get_db),
    _: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
    operator_username: Optional[str] = Query(default=None),
    action: Optional[str] = Query(default=None),
    entity_type: Optional[str] = Query(default=None),
    from_dt: Optional[datetime] = Query(default=None),
    to_dt: Optional[datetime] = Query(default=None),
    limit: int = Query(default=100, le=500),
    offset: int = Query(default=0, ge=0),
):
    repo = AuditLogRepository(db)
    filters = dict(
        operator_username=operator_username,
        action=action,
        entity_type=entity_type,
        from_dt=from_dt,
        to_dt=to_dt,
    )
    total = repo.count(**filters)
    items = repo.get_multi(**filters, limit=limit, offset=offset)
    return AuditLogPage(total=total, items=[AuditLogOut.model_validate(e) for e in items])
