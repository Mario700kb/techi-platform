from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.agent_auth import _SlidingWindowRateLimiter, login_limiter
from app.core.auth import (
    get_current_operator,
    get_operator_permissions,
    hash_password,
    mfa_enrollment_required,
    oauth2_scheme,
    verify_password,
)
from app.core.config import settings
from app.core.security import JWTError, create_access_token, decode_access_token
from app.db.session import get_db
from app.models.operator import Operator as OperatorModel
from app.repositories.operator_repository import OperatorRepository
from app.schemas.auth import (
    AuthSession,
    ChangePasswordRequest,
    LoginRequest,
    LoginResult,
    MfaCode,
    MfaDisableRequest,
    MfaLoginRequest,
    MfaSetup,
    MfaStatus,
    OperatorSessionOut,
    ProfileUpdateRequest,
    RecoveryCodes,
    SessionInfo,
)
from app.schemas.operator import Operator
from app.services.audit_service import AuditAction, audit_log
from app.services.auth_service import AuthService
from app.services.mfa_service import MfaError, MfaService
from app.services.permission_service import ALL_PERMISSIONS, permissions_summary
from app.services.session_service import (
    ACCESS_COOKIE,
    CSRF_HEADER,
    REFRESH_COOKIE,
    SessionService,
    clear_session_cookies,
    set_session_cookies,
)

router = APIRouter()

MFA_CHALLENGE_MINUTES = 5
# Six digits are guessable at volume; five tries per challenge window.
mfa_limiter = _SlidingWindowRateLimiter(limit=5, window_seconds=300)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _start_session(
    db: Session, request: Request, response: Response, operator: OperatorModel, *, mfa_verified: bool
) -> LoginResult:
    session, refresh_token = SessionService(db).create(
        operator,
        mfa_verified=mfa_verified,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    access_expires_at = set_session_cookies(response, operator, session, refresh_token)
    return LoginResult(
        user=Operator.model_validate(operator),
        session_expires_at=session.expires_at,
        access_expires_at=access_expires_at,
    )


def _current_session_id(request: Request) -> Optional[str]:
    return getattr(request.state, "session_id", None)


# -- sign-in -----------------------------------------------------------------


@router.post("/login", response_model=LoginResult)
def login(payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    if not login_limiter.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many login attempts")
    operator = AuthService(db).authenticate(payload.username, payload.password)
    if not operator:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    if operator.mfa_enabled:
        challenge = create_access_token(
            subject=str(operator.id),
            expires_delta=timedelta(minutes=MFA_CHALLENGE_MINUTES),
            extra_claims={"purpose": "mfa"},
        )
        return LoginResult(mfa_required=True, mfa_token=challenge)
    result = _start_session(db, request, response, operator, mfa_verified=False)
    audit_log(db, operator=operator, action=AuditAction.LOGIN)
    return result


@router.post("/login/mfa", response_model=LoginResult)
def login_mfa(payload: MfaLoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    try:
        claims = decode_access_token(payload.mfa_token)
        if claims.get("purpose") != "mfa":
            raise JWTError("wrong purpose")
        operator_id = int(claims.get("sub"))
    except (JWTError, TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign-in expired. Enter your password again.")
    if not mfa_limiter.is_allowed(f"operator:{operator_id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many attempts. Wait a few minutes.")
    operator = OperatorRepository(db).get(operator_id)
    if operator is None or not operator.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign-in expired. Enter your password again.")
    method = MfaService(db).verify(operator, payload.code)
    if method is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="That code is not valid")
    result = _start_session(db, request, response, operator, mfa_verified=True)
    audit_log(db, operator=operator, action=AuditAction.LOGIN, details={"mfa": method})
    return result


@router.post("/token-exchange", response_model=LoginResult)
def token_exchange(
    request: Request,
    response: Response,
    bearer_token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """One-time move of a pre-cookie browser session (a bearer token the old
    frontend kept in localStorage) to a cookie session, so the upgrade signs
    nobody out. Accepts only the Authorization header, never a cookie."""
    if not bearer_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials")
    try:
        claims = decode_access_token(bearer_token)
        if claims.get("purpose") or claims.get("sid"):
            raise JWTError("not a legacy access token")
        operator_id = int(claims.get("sub"))
    except (JWTError, TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials")
    operator = OperatorRepository(db).get(operator_id)
    if operator is None or not operator.is_active or operator.mfa_enabled:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials")
    return _start_session(db, request, response, operator, mfa_verified=False)


@router.post("/refresh", response_model=SessionInfo)
def refresh(request: Request, response: Response, db: Session = Depends(get_db)):
    if request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Missing CSRF header")
    token = request.cookies.get(REFRESH_COOKIE)
    rotated = SessionService(db).rotate(token) if token else None
    operator = OperatorRepository(db).get(rotated[0].operator_id) if rotated else None
    if rotated is None or operator is None or not operator.is_active:
        # Returned, not raised: an HTTPException would drop the cookie-clearing headers.
        expired = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "Session expired"})
        clear_session_cookies(expired)
        return expired
    session, new_token = rotated
    access_expires_at = set_session_cookies(response, operator, session, new_token)
    return SessionInfo(session_expires_at=session.expires_at, access_expires_at=access_expires_at)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, db: Session = Depends(get_db)):
    """Ends this browser's session. Works with an expired access token too —
    the refresh cookie still identifies the session to revoke."""
    service = SessionService(db)
    session = None
    refresh_token = request.cookies.get(REFRESH_COOKIE)
    if refresh_token:
        session = service.find_by_refresh_token(refresh_token)
    if session is None and request.cookies.get(ACCESS_COOKIE):
        try:
            sid = decode_access_token(request.cookies[ACCESS_COOKIE]).get("sid")
            session = service.get_live(sid) if sid else None
        except JWTError:
            session = None
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    if session is not None:
        service.revoke(session)
        operator = OperatorRepository(db).get(session.operator_id)
        if operator is not None:
            audit_log(db, operator=operator, action=AuditAction.LOGOUT)
    clear_session_cookies(response)
    return response


# -- the signed-in operator ----------------------------------------------------


@router.get("/me", response_model=Operator)
def read_me(operator: OperatorModel = Depends(get_current_operator)):
    return operator


@router.patch("/me", response_model=Operator)
def update_me(
    payload: ProfileUpdateRequest,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    """Edit your own display name and email. Changing the email asks for the
    current password, since it is how the account is reached."""
    changed: List[str] = []
    if "display_name" in payload.model_fields_set and payload.display_name != operator.display_name:
        operator.display_name = payload.display_name
        changed.append("display_name")

    new_email = str(payload.email).strip().lower() if payload.email else None
    if new_email and new_email != (operator.email or "").lower():
        if not payload.current_password:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter your current password to change your email")
        if not verify_password(payload.current_password, operator.hashed_password):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
        taken = (
            db.query(OperatorModel.id)
            .filter(func.lower(OperatorModel.email) == new_email, OperatorModel.id != operator.id)
            .first()
        )
        if taken:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Another operator already uses this email")
        previous_email = operator.email
        operator.email = new_email
        changed.append("email")

    if changed:
        db.add(operator)
        db.commit()
        db.refresh(operator)
        details = {"self": True, "fields": changed}
        if "display_name" in changed:
            details["display_name"] = operator.display_name
        if "email" in changed:
            details["email_from"] = previous_email
            details["email_to"] = operator.email
        audit_log(db, operator=operator, action=AuditAction.OPERATOR_UPDATED, entity_type="operator", entity_id=operator.id, details=details)
    return operator


def _operator_if_signed_in(
    request: Request,
    bearer_token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> Optional[OperatorModel]:
    """None when the browser holds no session at all (no access or refresh
    cookie, no Bearer): nothing to validate, and nothing to renew."""
    if not bearer_token and not request.cookies.get(ACCESS_COOKIE) and not request.cookies.get(REFRESH_COOKIE):
        return None
    return get_current_operator(request=request, bearer_token=bearer_token, db=db)


@router.get(
    "/session",
    response_model=AuthSession,
    responses={204: {"description": "Not signed in: this browser holds no session"}},
)
def read_session(
    request: Request,
    operator: Optional[OperatorModel] = Depends(_operator_if_signed_in),
    db: Session = Depends(get_db),
):
    # A signed-out browser asking "am I signed in?" is not an error. 204 lets
    # the app show the sign-in page without a 401 + failed refresh in the
    # console. With a session cookie, an expired one still answers 401 so
    # the app renews it.
    if operator is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    effective = get_operator_permissions(operator, db)
    permission_data = permissions_summary(operator.role) if effective is None else {
        "permissions": sorted(effective),
        "denied": sorted(ALL_PERMISSIONS - effective),
    }
    session_id = _current_session_id(request)
    session = SessionService(db).get_live(session_id) if session_id else None
    return AuthSession(
        user=Operator.model_validate(operator),
        permissions=permission_data["permissions"],
        denied=permission_data["denied"],
        session_expires_at=session.expires_at if session else None,
        access_expires_at=getattr(request.state, "access_expires_at", None),
        mfa_enrollment_required=mfa_enrollment_required(operator),
    )


@router.post("/change-password", status_code=status.HTTP_200_OK)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
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
    # A changed password must end every other signed-in browser.
    SessionService(db).revoke_all(operator.id, except_session_id=_current_session_id(request))
    audit_log(db, operator=operator, action=AuditAction.UPDATE_OPERATOR)
    return {"message": "Password changed successfully"}


@router.get("/permissions/me")
def my_permissions(
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    effective = get_operator_permissions(operator, db)
    if effective is None:
        return permissions_summary(operator.role)
    return {
        "role": operator.role,
        "permissions": sorted(effective),
        "denied": sorted(ALL_PERMISSIONS - effective),
    }


# -- signed-in browsers ---------------------------------------------------------


@router.get("/sessions", response_model=List[OperatorSessionOut])
def list_sessions(
    request: Request,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    current = _current_session_id(request)
    return [
        OperatorSessionOut(
            id=row.id,
            created_at=row.created_at,
            last_used_at=row.last_used_at,
            expires_at=row.expires_at,
            ip_address=row.ip_address,
            user_agent=row.user_agent,
            current=row.id == current,
        )
        for row in SessionService(db).list_live(operator.id)
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session(
    session_id: str,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    service = SessionService(db)
    session = service.get_live(session_id)
    if session is None or session.operator_id != operator.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    service.revoke(session)
    audit_log(db, operator=operator, action=AuditAction.SESSION_REVOKED)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sessions/revoke-others")
def revoke_other_sessions(
    request: Request,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    count = SessionService(db).revoke_all(operator.id, except_session_id=_current_session_id(request))
    if count:
        audit_log(db, operator=operator, action=AuditAction.SESSION_REVOKED, details={"count": count})
    return {"revoked": count}


# -- two-factor authentication ----------------------------------------------------


def _mfa_status(db: Session, operator: OperatorModel) -> MfaStatus:
    return MfaStatus(
        enabled=bool(operator.mfa_enabled),
        enabled_at=operator.mfa_enabled_at,
        required=operator.role in settings.MFA_REQUIRED_ROLES,
        recovery_codes_remaining=MfaService(db).recovery_codes_remaining(operator),
    )


@router.get("/mfa", response_model=MfaStatus)
def mfa_status(operator: OperatorModel = Depends(get_current_operator), db: Session = Depends(get_db)):
    return _mfa_status(db, operator)


@router.post("/mfa/setup", response_model=MfaSetup)
def mfa_setup(operator: OperatorModel = Depends(get_current_operator), db: Session = Depends(get_db)):
    try:
        return MfaSetup(**MfaService(db).start_setup(operator))
    except MfaError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.post("/mfa/enable", response_model=RecoveryCodes)
def mfa_enable(
    payload: MfaCode,
    request: Request,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    if not mfa_limiter.is_allowed(f"operator:{operator.id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many attempts. Wait a few minutes.")
    try:
        codes = MfaService(db).confirm(operator, payload.code)
    except MfaError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    service = SessionService(db)
    session_id = _current_session_id(request)
    session = service.get_live(session_id) if session_id else None
    if session is not None:
        service.mark_mfa_verified(session)
    # Sessions opened with only a password end once MFA is on.
    service.revoke_all(operator.id, except_session_id=session_id)
    audit_log(db, operator=operator, action=AuditAction.MFA_ENABLED)
    return RecoveryCodes(recovery_codes=codes)


@router.post("/mfa/disable", status_code=status.HTTP_204_NO_CONTENT)
def mfa_disable(
    payload: MfaDisableRequest,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    if operator.role in settings.MFA_REQUIRED_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Two-factor authentication is required for your role")
    if not mfa_limiter.is_allowed(f"operator:{operator.id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many attempts. Wait a few minutes.")
    if not verify_password(payload.password, operator.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password is incorrect")
    service = MfaService(db)
    if service.verify(operator, payload.code) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That code is not valid")
    service.disable(operator)
    audit_log(db, operator=operator, action=AuditAction.MFA_DISABLED)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/mfa/recovery-codes", response_model=RecoveryCodes)
def mfa_regenerate_recovery_codes(
    payload: MfaCode,
    operator: OperatorModel = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    if not mfa_limiter.is_allowed(f"operator:{operator.id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many attempts. Wait a few minutes.")
    service = MfaService(db)
    if service.verify(operator, payload.code) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That code is not valid")
    codes = service.regenerate_recovery_codes(operator)
    audit_log(db, operator=operator, action=AuditAction.MFA_RECOVERY_CODES_REGENERATED)
    return RecoveryCodes(recovery_codes=codes)
