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


@router.put("/{token_id}/revoke", response_model=EnrollmentTokenOut)
def revoke_enrollment_token(
    token_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        return EnrollmentTokenService(db).revoke(token_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/verify", response_model=EnrollmentTokenVerifyResponse)
def verify_enrollment_token(
    payload: EnrollmentTokenVerifyRequest,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
):
    return EnrollmentTokenService(db).peek(payload.token)
