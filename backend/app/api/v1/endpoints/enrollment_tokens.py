from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_roles
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.schemas.enrollment_token import (
    EnrollmentTokenCreate,
    EnrollmentTokenCreateResponse,
    EnrollmentTokenOut,
    EnrollmentTokenVerifyRequest,
    EnrollmentTokenVerifyResponse,
)
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.audit_service import AuditAction, audit_log

router = APIRouter()


@router.post("", response_model=EnrollmentTokenCreateResponse)
def create_enrollment_token(
    payload: EnrollmentTokenCreate,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    return EnrollmentTokenService(db).create(payload)


@router.get("", response_model=List[EnrollmentTokenOut])
def list_enrollment_tokens(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    limit: int = Query(default=100, le=200),
    offset: int = Query(default=0, ge=0),
):
    return EnrollmentTokenService(db).list(limit=limit, offset=offset)


@router.post("/default/regenerate", response_model=EnrollmentTokenCreateResponse)
def regenerate_default_enrollment_token(
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    result = EnrollmentTokenService(db).regenerate_default()
    audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_REGENERATED, entity_type="enrollment_token", entity_id=result.id, details={"name": result.name})
    return result


@router.put("/{token_id}/revoke", response_model=EnrollmentTokenOut)
def revoke_enrollment_token(
    token_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        token = EnrollmentTokenService(db).revoke(token_id)
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_REVOKED, entity_type="enrollment_token", entity_id=token.id, details={"name": token.name})
        return token
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete("/{token_id}", response_model=EnrollmentTokenOut)
def delete_enrollment_token(
    token_id: int,
    confirm_active: bool = Query(default=False),
    confirm_default: bool = Query(default=False),
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        token = EnrollmentTokenService(db).delete(
            token_id,
            confirm_active=confirm_active,
            confirm_default=confirm_default,
        )
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_DELETED, entity_type="enrollment_token", entity_id=token.id, details={"name": token.name, "status": token.status.value if hasattr(token.status, "value") else token.status})
        return token
    except ValueError as exc:
        detail = str(exc)
        if "not found" in detail.lower():
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)


@router.post("/verify", response_model=EnrollmentTokenVerifyResponse)
def verify_enrollment_token(
    payload: EnrollmentTokenVerifyRequest,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
):
    return EnrollmentTokenService(db).peek(payload.token)
