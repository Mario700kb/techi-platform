from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core import presence
from app.core.auth import get_current_operator, require_min_role
from app.db.session import get_db
from app.models.operator import Operator as OperatorModel, OperatorRole
from app.schemas.operator import Operator, OperatorCreate, OperatorPasswordReset, OperatorUpdate
from app.services.audit_service import AuditAction, audit_log
from app.services.operator_service import OperatorService

router = APIRouter()


@router.get("", response_model=List[Operator])
def list_operators(
    db: Session = Depends(get_db),
    current: OperatorModel = Depends(get_current_operator),
):
    operators = OperatorService(db).list_operators()
    result = []
    for op in operators:
        record = Operator.model_validate(op)
        record.last_active_at = presence.get_last_active(op.id)
        result.append(record)
    return result


@router.post("", response_model=Operator, status_code=status.HTTP_201_CREATED)
def create_operator(
    payload: OperatorCreate,
    db: Session = Depends(get_db),
    current: OperatorModel = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    try:
        created = OperatorService(db).create_operator(payload, current)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit_log(db, operator=current, action=AuditAction.OPERATOR_CREATED, entity_type="operator", entity_id=created.id, details={"target_username": created.username, "role": created.role})
    return created


@router.put("/{operator_id}", response_model=Operator)
def update_operator(
    operator_id: int,
    payload: OperatorUpdate,
    db: Session = Depends(get_db),
    current: OperatorModel = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    try:
        updated = OperatorService(db).update_operator(operator_id, payload, current)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit_log(db, operator=current, action=AuditAction.OPERATOR_UPDATED, entity_type="operator", entity_id=operator_id, details=payload.model_dump(exclude_none=True))
    return updated


@router.delete("/{operator_id}", response_model=Operator)
def delete_operator(
    operator_id: int,
    db: Session = Depends(get_db),
    current: OperatorModel = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    try:
        deleted = OperatorService(db).delete_operator(operator_id, current)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit_log(db, operator=current, action=AuditAction.OPERATOR_DELETED, entity_type="operator", entity_id=operator_id, details={"target_username": deleted.username})
    return deleted


@router.put("/{operator_id}/password", response_model=Operator)
def reset_operator_password(
    operator_id: int,
    payload: OperatorPasswordReset,
    db: Session = Depends(get_db),
    current: OperatorModel = Depends(get_current_operator),
):
    try:
        result = OperatorService(db).reset_password(operator_id, payload, current)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit_log(db, operator=current, action=AuditAction.OPERATOR_PASSWORD_RESET, entity_type="operator", entity_id=operator_id)
    return result
