import base64
import hmac
import hashlib
import secrets
from datetime import timedelta
from typing import Iterable

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token, decode_access_token
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.repositories.operator_repository import OperatorRepository

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_PREFIX}/auth/login")

ROLE_ORDER = {
    OperatorRole.READONLY.value: 0,
    OperatorRole.OPERATOR.value: 1,
    OperatorRole.ADMIN.value: 2,
    OperatorRole.OWNER.value: 3,
}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 260000)
    return "pbkdf2_sha256$260000$%s$%s" % (
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, rounds_raw, salt_raw, digest_raw = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_raw)
        expected = base64.b64decode(digest_raw)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(rounds_raw))
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


def create_operator_token(operator: Operator) -> str:
    return create_access_token(
        subject=str(operator.id),
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
        extra_claims={"role": operator.role, "username": operator.username},
    )


def get_current_operator(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> Operator:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_access_token(token)
        subject = payload.get("sub")
        operator_id = int(subject)
    except (JWTError, TypeError, ValueError):
        raise credentials_error

    operator = OperatorRepository(db).get(operator_id)
    if operator is None or not operator.is_active:
        raise credentials_error
    from app.core import presence
    presence.touch(operator.id)
    return operator


def require_roles(*roles: str):
    def dependency(operator: Operator = Depends(get_current_operator)) -> Operator:
        if operator.role == OperatorRole.OWNER.value:
            return operator
        if operator.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
        return operator

    return dependency


def require_min_role(role: str):
    def dependency(operator: Operator = Depends(get_current_operator)) -> Operator:
        current = ROLE_ORDER.get(operator.role, -1)
        required = ROLE_ORDER.get(role, 99)
        if current < required:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
        return operator

    return dependency


def role_in(operator: Operator, roles: Iterable[str]) -> bool:
    return operator.role == OperatorRole.OWNER.value or operator.role in set(roles)


def is_unrestricted(operator: Operator) -> bool:
    """Return True for owner/admin — no scope enforcement needed."""
    return operator.role in (OperatorRole.OWNER.value, OperatorRole.ADMIN.value)


def get_operator_scope(
    operator: Operator = Depends(get_current_operator),
    db: Session = Depends(get_db),
):
    """FastAPI dependency — returns None if the operator is unrestricted (owner/admin),
    or an AllowedScope for operator/readonly roles.

    Inject as: scope: Optional[AllowedScope] = Depends(get_operator_scope)
    """
    from app.core.scope import AllowedScope  # local import to avoid circular at module load
    from app.services.operator_scope_service import OperatorScopeService

    if is_unrestricted(operator):
        return None
    return OperatorScopeService(db).get_allowed_scope(operator.id)

