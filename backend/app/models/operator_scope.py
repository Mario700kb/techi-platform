from datetime import datetime
from enum import Enum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint

from app.db.base import Base


class ScopeType(str, Enum):
    CLIENT = "client"
    GROUP = "group"
    DEVICE = "device"


class OperatorScope(Base):
    __tablename__ = "operator_scopes"

    id = Column(Integer, primary_key=True, index=True)
    operator_id = Column(
        Integer,
        ForeignKey("operators.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    scope_type = Column(String(16), nullable=False)   # 'client' | 'group' | 'device'
    scope_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("operator_id", "scope_type", "scope_id", name="uq_operator_scope"),
    )
