from datetime import datetime
from enum import Enum
from typing import Optional, Union

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.types import TypeDecorator

from app.db.base import Base


class EnrollmentTokenStatus(str, Enum):
    ACTIVE = "active"
    REVOKED = "revoked"
    EXPIRED = "expired"
    USED = "used"


class EnrollmentTokenStatusType(TypeDecorator):
    impl = String(16)
    cache_ok = True

    def process_bind_param(self, value: Optional[Union[EnrollmentTokenStatus, str]], dialect) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, EnrollmentTokenStatus):
            return value.value
        normalized = str(value).strip()
        if not normalized:
            return normalized
        try:
            return EnrollmentTokenStatus[normalized.upper()].value
        except KeyError:
            return normalized.lower()

    def process_result_value(self, value: Optional[str], dialect) -> Optional[EnrollmentTokenStatus]:
        if value is None:
            return None
        normalized = str(value).strip()
        try:
            return EnrollmentTokenStatus[normalized.upper()]
        except KeyError:
            return EnrollmentTokenStatus(normalized.lower())


# Fraction of max_uses at which a token starts surfacing a usage warning.
TOKEN_USAGE_WARNING_THRESHOLD = 0.9


class EnrollmentToken(Base):
    __tablename__ = "enrollment_tokens"
    __table_args__ = (
        Index("ix_enrollment_tokens_status_expires_at", "status", "expires_at"),
        Index("ix_enrollment_tokens_client_group", "client_id", "group_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(160), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    status = Column(EnrollmentTokenStatusType(), default=EnrollmentTokenStatus.ACTIVE, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=True, index=True)
    used_at = Column(DateTime, nullable=True)
    max_uses = Column(Integer, default=1, nullable=False)
    use_count = Column(Integer, default=0, nullable=False)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    group_id = Column(Integer, ForeignKey("device_groups.id"), nullable=True, index=True)
    is_default = Column(Boolean, default=False, nullable=False)
    token_prefix = Column(String(12), nullable=True)
    token_ciphertext = Column(Text, nullable=True)
    is_internal = Column(Boolean, default=False, nullable=False, index=True)
    internal_kind = Column(String(32), nullable=True, index=True)

    @property
    def has_recoverable_token(self) -> bool:
        return bool(self.token_ciphertext)

    @property
    def usage_warning(self) -> Optional[str]:
        """"critical" when use_count has hit max_uses, "warning" at 90%+, else None.

        Only meaningful for tokens that can still be handed to agents (active)
        or were exhausted by use (used); revoked/expired tokens stay silent.
        """
        status = self.status.value if hasattr(self.status, "value") else self.status
        if status not in (EnrollmentTokenStatus.ACTIVE.value, EnrollmentTokenStatus.USED.value):
            return None
        if not self.max_uses:
            return None
        used = self.use_count or 0
        if used >= self.max_uses:
            return "critical"
        if used >= TOKEN_USAGE_WARNING_THRESHOLD * self.max_uses:
            return "warning"
        return None
