from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text

from app.db.base import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    operator_id = Column(Integer, nullable=True)
    operator_username = Column(String(128), nullable=True, index=True)
    action = Column(String(64), nullable=False, index=True)
    entity_type = Column(String(64), nullable=True, index=True)
    entity_id = Column(Integer, nullable=True)
    details_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
