from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String

from app.core.time import utcnow
from app.db.base import Base


class OperatorSession(Base):
    """One signed-in browser. Access tokens carry its id (`sid`), so revoking
    the row ends the session on the next request, not when a JWT expires."""

    __tablename__ = "operator_sessions"

    id = Column(String(43), primary_key=True)  # random, url-safe
    operator_id = Column(Integer, ForeignKey("operators.id", ondelete="CASCADE"), nullable=False, index=True)
    refresh_token_hash = Column(String(64), nullable=False, unique=True)
    # The token this one replaced, still accepted for REFRESH_GRACE after the
    # rotation: several tabs renew at the same moment with the same cookie,
    # and only the first would otherwise succeed (the rest signed out).
    previous_refresh_token_hash = Column(String(64), nullable=True, index=True)
    refresh_rotated_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_used_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    mfa_verified = Column(Boolean, default=False, nullable=False)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(300), nullable=True)
