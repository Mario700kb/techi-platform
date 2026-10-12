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
    created_at = Column(DateTime, default=utcnow, nullable=False)
    last_used_at = Column(DateTime, default=utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    mfa_verified = Column(Boolean, default=False, nullable=False)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(300), nullable=True)
