from sqlalchemy import Column, DateTime, Integer, String

from app.core.time import utcnow_naive
from app.db.base import Base


class RevokedAgent(Base):
    """An agent the platform no longer accepts: its device was archived or
    moved to the trash. Its heartbeats and command channel are refused, so
    the device does not come back on its own while the agent is still
    installed. Restoring the device, or "Allow back", removes the row.

    Outlives the device: after the trash is purged the agent is still known
    here, with when it last tried to connect.
    """

    __tablename__ = "revoked_agents"

    id = Column(Integer, primary_key=True)
    agent_id = Column(String(128), nullable=False, unique=True)
    device_id = Column(Integer, nullable=True, index=True)
    hostname = Column(String(255), nullable=True)
    client_id = Column(Integer, nullable=True)
    reason = Column(String(500), nullable=True)
    revoked_at = Column(DateTime, nullable=False, default=utcnow_naive)
    revoked_by = Column(String(128), nullable=True)
    last_attempt_at = Column(DateTime, nullable=True)
    last_attempt_ip = Column(String(64), nullable=True)
    attempt_count = Column(Integer, nullable=False, default=0)
