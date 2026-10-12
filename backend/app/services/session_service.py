"""Browser sessions: HttpOnly cookies, rotating refresh tokens, revocation.

The access token is a short JWT carrying the session id (`sid`); every request
checks that the session row is still live, so signing out — or an admin
resetting someone's MFA — ends the session immediately. The refresh token is
an opaque random string stored only as a SHA-256 digest and replaced on every
use.
"""
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from fastapi import Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.core.time import ensure_utc, utcnow
from app.models.operator import Operator
from app.models.operator_session import OperatorSession

ACCESS_COOKIE = "techi_access"
REFRESH_COOKIE = "techi_refresh"
# Required on every cookie-authenticated request that changes state. A page
# on another site cannot set a custom header without a CORS preflight, which
# BACKEND_CORS_ORIGINS refuses, so a forged form post or link never carries it.
CSRF_HEADER = "X-TECHI-CSRF"


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def refresh_cookie_path() -> str:
    # The refresh token is only ever sent to the auth endpoints.
    return f"{settings.API_PREFIX}/auth"


class SessionService:
    def __init__(self, db: Session):
        self.db = db

    def create(
        self,
        operator: Operator,
        *,
        mfa_verified: bool,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> Tuple[OperatorSession, str]:
        now = utcnow()
        refresh_token = secrets.token_urlsafe(32)
        session = OperatorSession(
            id=secrets.token_urlsafe(32),
            operator_id=operator.id,
            refresh_token_hash=_digest(refresh_token),
            created_at=now,
            last_used_at=now,
            expires_at=now + timedelta(hours=settings.SESSION_MAX_HOURS),
            mfa_verified=mfa_verified,
            ip_address=(ip_address or "")[:64] or None,
            user_agent=(user_agent or "")[:300] or None,
        )
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)
        return session, refresh_token

    @staticmethod
    def is_live(session: Optional[OperatorSession], now: Optional[datetime] = None) -> bool:
        if session is None or session.revoked_at is not None:
            return False
        now = now or utcnow()
        if ensure_utc(session.expires_at) <= now:
            return False
        idle_limit = ensure_utc(session.last_used_at) + timedelta(minutes=settings.SESSION_IDLE_MINUTES)
        return idle_limit > now

    def get_live(self, session_id: str) -> Optional[OperatorSession]:
        session = self.db.get(OperatorSession, session_id)
        return session if self.is_live(session) else None

    def rotate(self, refresh_token: str) -> Optional[Tuple[OperatorSession, str]]:
        """Swap a valid refresh token for a new one; None if it is not valid."""
        session = (
            self.db.query(OperatorSession)
            .filter(OperatorSession.refresh_token_hash == _digest(refresh_token))
            .one_or_none()
        )
        if not self.is_live(session):
            return None
        new_token = secrets.token_urlsafe(32)
        session.refresh_token_hash = _digest(new_token)
        session.last_used_at = utcnow()
        self.db.commit()
        self.db.refresh(session)
        return session, new_token

    def find_by_refresh_token(self, refresh_token: str) -> Optional[OperatorSession]:
        return (
            self.db.query(OperatorSession)
            .filter(OperatorSession.refresh_token_hash == _digest(refresh_token))
            .one_or_none()
        )

    def revoke(self, session: OperatorSession) -> None:
        if session.revoked_at is None:
            session.revoked_at = utcnow()
            self.db.commit()

    def revoke_all(self, operator_id: int, *, except_session_id: Optional[str] = None) -> int:
        query = self.db.query(OperatorSession).filter(
            OperatorSession.operator_id == operator_id,
            OperatorSession.revoked_at.is_(None),
        )
        if except_session_id:
            query = query.filter(OperatorSession.id != except_session_id)
        count = query.update({OperatorSession.revoked_at: utcnow()}, synchronize_session=False)
        self.db.commit()
        return count

    def list_live(self, operator_id: int) -> List[OperatorSession]:
        rows = (
            self.db.query(OperatorSession)
            .filter(OperatorSession.operator_id == operator_id, OperatorSession.revoked_at.is_(None))
            .order_by(OperatorSession.last_used_at.desc())
            .all()
        )
        now = utcnow()
        return [row for row in rows if self.is_live(row, now)]

    def mark_mfa_verified(self, session: OperatorSession) -> None:
        session.mfa_verified = True
        self.db.commit()


def access_token_for(operator: Operator, session: OperatorSession) -> str:
    # Never outlives the session it belongs to.
    remaining = ensure_utc(session.expires_at) - utcnow()
    lifetime = min(timedelta(minutes=settings.SESSION_ACCESS_MINUTES), remaining)
    return create_access_token(
        subject=str(operator.id),
        expires_delta=lifetime,
        extra_claims={"role": operator.role, "username": operator.username, "sid": session.id},
    )


def set_session_cookies(response: Response, operator: Operator, session: OperatorSession, refresh_token: str) -> None:
    common = {"httponly": True, "secure": settings.SESSION_COOKIE_SECURE, "samesite": "strict"}
    response.set_cookie(
        ACCESS_COOKIE,
        access_token_for(operator, session),
        max_age=settings.SESSION_ACCESS_MINUTES * 60,
        path="/",
        **common,
    )
    refresh_seconds = int((ensure_utc(session.expires_at) - utcnow()).total_seconds())
    response.set_cookie(
        REFRESH_COOKIE,
        refresh_token,
        max_age=max(refresh_seconds, 0),
        path=refresh_cookie_path(),
        **common,
    )


def clear_session_cookies(response: Response) -> None:
    common = {"httponly": True, "secure": settings.SESSION_COOKIE_SECURE, "samesite": "strict"}
    response.delete_cookie(ACCESS_COOKIE, path="/", **common)
    response.delete_cookie(REFRESH_COOKIE, path=refresh_cookie_path(), **common)
