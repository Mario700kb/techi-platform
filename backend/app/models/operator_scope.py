from enum import Enum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint

from app.db.base import Base
from app.core.time import utcnow_naive


class ScopeType(str, Enum):
    CLIENT = "client"
    GROUP = "group"
    DEVICE = "device"


class OperatorScope(Base):
    __tablename__ = "operator_scopes"

    id = Column(Integer, primary_key=True)
    operator_id = Column(
        Integer,
        ForeignKey("operators.id", ondelete="CASCADE"),
        nullable=False,
    )
    scope_type = Column(String(16), nullable=False)   # 'client' | 'group' | 'device'
    scope_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)

    __table_args__ = (
        UniqueConstraint("operator_id", "scope_type", "scope_id", name="uq_operator_scope"),
    )
