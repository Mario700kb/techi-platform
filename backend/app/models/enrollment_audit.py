from sqlalchemy import Column, DateTime, Index, Integer, String, Text

from app.core.time import utcnow
from app.db.base import Base


class EnrollmentAudit(Base):
    __tablename__ = "enrollment_audit"
    __table_args__ = (
        Index("ix_enrollment_audit_token_id", "token_id"),
        Index("ix_enrollment_audit_created_at", "created_at"),
        Index("ix_enrollment_audit_device_id", "device_id"),
        Index("ix_enrollment_audit_result", "result"),
    )

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    token_id = Column(Integer, nullable=True)
    token_name = Column(String(160), nullable=True)
    token_prefix = Column(String(12), nullable=True)
    client_id = Column(Integer, nullable=True)
    group_id = Column(Integer, nullable=True)
    device_id = Column(Integer, nullable=True)
    hostname = Column(String(128), nullable=True)
    username = Column(String(128), nullable=True)
    domain = Column(String(128), nullable=True)
    rustdesk_id = Column(String(64), nullable=True)
    public_ip = Column(String(45), nullable=True)
    local_ip = Column(String(45), nullable=True)
    result = Column(String(32), nullable=False)
    reason = Column(String(255), nullable=True)
    raw_error = Column(Text, nullable=True)
    fingerprint = Column(String(255), nullable=True)
    agent_id = Column(String(80), nullable=True)
