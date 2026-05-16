"""
Scope management endpoints for operators.
Admin/owner can view and modify the scope assigned to any operator.
Operators can view their own scope (read-only).
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.repositories.operator_repository import OperatorRepository
from app.schemas.operator_scope import ScopeEntryCreate, ScopeEntryResponse, ScopeReplaceRequest
from app.services.audit_service import AuditAction, audit_log
from app.services.operator_scope_service import OperatorScopeService

router = APIRouter()


def _get_target_operator(operator_id: int, db: Session) -> Operator:
    op = OperatorRepository(db).get(operator_id)
    if not op:
        raise HTTPException(status_code=404, detail="Operator not found")
    return op


@router.get("/{operator_id}/scopes", response_model=List[ScopeEntryResponse])
def list_operator_scopes(
    operator_id: int,
    db: Session = Depends(get_db),
    caller: Operator = Depends(get_current_operator),
):
    """List all scope entries for an operator.

    Callers can always view their own scope.
    Viewing another operator's scope requires admin+.
    """
    from app.core.auth import ROLE_ORDER
    if caller.id != operator_id:
        if ROLE_ORDER.get(caller.role, -1) < ROLE_ORDER.get(OperatorRole.ADMIN.value, 2):
            raise HTTPException(status_code=403, detail="Insufficient role")
    _get_target_operator(operator_id, db)
    return OperatorScopeService(db).list_entries(operator_id)


@router.post("/{operator_id}/scopes", response_model=ScopeEntryResponse)
def add_operator_scope(
    operator_id: int,
    payload: ScopeEntryCreate,
    db: Session = Depends(get_db),
    caller: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    """Add a single scope entry to an operator (idempotent)."""
    target = _get_target_operator(operator_id, db)
    if target.role in (OperatorRole.OWNER.value, OperatorRole.ADMIN.value):
        raise HTTPException(status_code=400, detail="Cannot scope owner or admin accounts — they have unrestricted access")
    entry = OperatorScopeService(db).add_entry(operator_id, payload.scope_type.value, payload.scope_id)
    audit_log(db, operator=caller, action=AuditAction.SCOPE_ENTRY_ADDED, entity_type="operator", entity_id=operator_id, details={"target_username": target.username, "scope_type": payload.scope_type.value, "scope_id": payload.scope_id})
    return entry


@router.delete("/{operator_id}/scopes/{entry_id}", response_model=ScopeEntryResponse)
def remove_operator_scope(
    operator_id: int,
    entry_id: int,
    db: Session = Depends(get_db),
    caller: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    """Remove a specific scope entry from an operator."""
    target = _get_target_operator(operator_id, db)
    removed = OperatorScopeService(db).remove_entry(operator_id, entry_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Scope entry not found")
    audit_log(db, operator=caller, action=AuditAction.SCOPE_ENTRY_REMOVED, entity_type="operator", entity_id=operator_id, details={"target_username": target.username, "scope_type": removed.scope_type, "scope_id": removed.scope_id})
    return removed


@router.put("/{operator_id}/scopes", response_model=List[ScopeEntryResponse])
def replace_operator_scopes(
    operator_id: int,
    payload: ScopeReplaceRequest,
    db: Session = Depends(get_db),
    caller: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    """Atomically replace all scope entries for an operator."""
    target = _get_target_operator(operator_id, db)
    if target.role in (OperatorRole.OWNER.value, OperatorRole.ADMIN.value):
        raise HTTPException(status_code=400, detail="Cannot scope owner or admin accounts — they have unrestricted access")
    entries = [{"scope_type": e.scope_type.value, "scope_id": e.scope_id} for e in payload.entries]
    result = OperatorScopeService(db).replace_scope(operator_id, entries)
    audit_log(db, operator=caller, action=AuditAction.SCOPE_REPLACED, entity_type="operator", entity_id=operator_id, details={"target_username": target.username, "entry_count": len(result)})
    return result
