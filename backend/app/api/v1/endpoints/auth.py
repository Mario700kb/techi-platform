from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.agent_auth import login_limiter
from app.core.auth import create_operator_token, get_current_operator, hash_password, verify_password
from app.core.config import settings
from app.db.session import get_db
from app.models.operator import Operator as OperatorModel
from app.schemas.auth import ChangePasswordRequest, LoginRequest, TokenResponse
from app.services.permission_service import permissions_summary
from app.schemas.operator import Operator
from app.services.audit_service import AuditAction, audit_log
from app.services.auth_service import AuthService

router = APIRouter()


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else "unknown"
    if not login_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many login attempts")
    operator = AuthService(db).authenticate(payload.username, payload.password)
    if not operator:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    audit_log(db, operator=operator, action=AuditAction.LOGIN)
    return TokenResponse(
        access_token=create_operator_token(operator),
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=Operator.model_validate(operator),
    )


@router.get("/me", response_model=Operator)
def read_me(operator: OperatorModel = Depends(get_current_operator)):
    return operator


@router.post("/change-password", status_code=status.HTTP_200_OK)
def change_password(
    payload: ChangePasswordRequest,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    if not verify_password(payload.current_password, operator.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    operator.hashed_password = hash_password(payload.new_password)
    db.add(operator)
    db.commit()
    audit_log(db, operator=operator, action=AuditAction.UPDATE_OPERATOR)
    return {"message": "Password changed successfully"}



@router.get("/permissions/me")
def my_permissions(
    operator: OperatorModel = Depends(get_current_operator),
):
    return permissions_summary(operator.role)
