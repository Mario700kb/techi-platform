from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String

from app.db.base import Base


class RemoteSupportConnectToken(Base):
    __tablename__ = "remote_support_connect_tokens"
    __table_args__ = (
        Index("ix_rs_connect_tokens_device_created", "device_id", "created_at"),
        Index("ix_rs_connect_tokens_expires_consumed", "expires_at", "consumed_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    receipt_hash = Column(String(64), nullable=True, unique=True, index=True)
    purpose = Column(String(64), nullable=False)
    operator_id = Column(Integer, ForeignKey("operators.id", ondelete="CASCADE"), nullable=False, index=True)
    operator_username = Column(String(80), nullable=False)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    remote_id = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    consumed_at = Column(DateTime, nullable=True)
    reported_at = Column(DateTime, nullable=True)
    launch_result = Column(String(32), nullable=True)
    failure_code = Column(String(64), nullable=True)
