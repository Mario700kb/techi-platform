from datetime import datetime
from enum import Enum

from sqlalchemy import Boolean, Column, DateTime, Enum as SQLEnum, ForeignKey, Index, Integer, String

from app.db.base import Base


class EnrollmentTokenStatus(str, Enum):
    ACTIVE = "active"
    REVOKED = "revoked"
    EXPIRED = "expired"
    USED = "used"


def enrollment_token_status_values(statuses: type[EnrollmentTokenStatus]) -> list[str]:
    return [status.name for status in statuses]


class EnrollmentToken(Base):
    __tablename__ = "enrollment_tokens"
    __table_args__ = (
        Index("ix_enrollment_tokens_status_expires_at", "status", "expires_at"),
        Index("ix_enrollment_tokens_client_group", "client_id", "group_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(160), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    status = Column(
        SQLEnum(
            EnrollmentTokenStatus,
            native_enum=False,
            create_constraint=False,
            values_callable=enrollment_token_status_values,
        ),
        default=EnrollmentTokenStatus.ACTIVE,
        nullable=False,
        index=True,
    )
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=True, index=True)
    used_at = Column(DateTime, nullable=True)
    max_uses = Column(Integer, default=1, nullable=False)
    use_count = Column(Integer, default=0, nullable=False)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    group_id = Column(Integer, ForeignKey("device_groups.id"), nullable=True, index=True)
    is_default = Column(Boolean, default=False, nullable=False)
    token_prefix = Column(String(12), nullable=True)
