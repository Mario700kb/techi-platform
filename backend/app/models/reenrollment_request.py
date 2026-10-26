from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint

from app.core.time import utcnow_naive
from app.db.base import Base


class ReenrollmentRequest(Base):
    """An enrollment that matched an existing device without proving it is
    that device's agent (a reinstalled machine, a clone, or someone else).

    The device keeps its identity until an admin decides: hand the device
    over to the new agent, enroll the new agent as a separate device, or
    reject it. Until then the new agent's heartbeats change nothing.
    """

    __tablename__ = "reenrollment_requests"

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    agent_id = Column(String(128), nullable=False)
    matched_by = Column(String(32), nullable=False)
    status = Column(String(16), nullable=False, default="pending")
    hostname = Column(String(255), nullable=True)
    current_user = Column(String(255), nullable=True)
    domain = Column(String(255), nullable=True)
    local_ip = Column(String(64), nullable=True)
    public_ip = Column(String(64), nullable=True)
    rustdesk_id = Column(String(64), nullable=True)
    os_caption = Column(String(255), nullable=True)
    platform = Column(String(64), nullable=True)
    token_name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow_naive)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    decided_by = Column(String(128), nullable=True)
    decision = Column(String(16), nullable=True)
    new_device_id = Column(Integer, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True)

    __table_args__ = (
        UniqueConstraint("device_id", "agent_id", name="uq_reenrollment_request_device_agent"),
        Index("ix_reenrollment_requests_status", "status"),
    )
