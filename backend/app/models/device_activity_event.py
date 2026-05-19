from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text

from app.core.time import utcnow
from app.db.base import Base


class DeviceActivityEvent(Base):
    __tablename__ = "device_activity_events"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String(64), nullable=False, index=True)
    summary = Column(String(255), nullable=False)
    detail = Column(Text, nullable=True)
    actor = Column(String(128), nullable=True)
    occurred_at = Column(DateTime, default=utcnow, nullable=False, index=True)

