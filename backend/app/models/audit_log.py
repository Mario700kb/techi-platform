
from sqlalchemy import Column, DateTime, Integer, String, Text

from app.db.base import Base
from app.core.time import utcnow_naive


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True)
    operator_id = Column(Integer, nullable=True)
    operator_username = Column(String(128), nullable=True, index=True)
    action = Column(String(64), nullable=False, index=True)
    entity_type = Column(String(64), nullable=True, index=True)
    entity_id = Column(Integer, nullable=True)
    details_json = Column(Text, nullable=True)
    # The device and client an entry concerns, resolved when it is written, so
    # a client's activity is an indexed lookup rather than a scan of details_json.
    device_id = Column(Integer, nullable=True, index=True)
    client_id = Column(Integer, nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False, index=True)
