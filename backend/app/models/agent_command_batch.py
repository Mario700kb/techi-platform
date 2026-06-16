from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.core.time import utcnow
from app.db.base import Base


class AgentCommandBatch(Base):
    __tablename__ = "agent_command_batches"

    id = Column(String(36), primary_key=True)
    command_type = Column(String(64), nullable=False)
    payload = Column(Text, nullable=False, default="{}")
    target = Column(String(32), nullable=False)
    timeout_seconds = Column(Integer, nullable=False, default=30)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    created_by = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True)

    remote_actions = relationship(
        "RemoteAction",
        back_populates="batch",
        foreign_keys="RemoteAction.batch_id",
    )
