
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.core.time import utcnow_naive


class DeviceNote(Base):
    __tablename__ = "device_notes"

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    note = Column(Text, nullable=False)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False)

    device = relationship("Device", back_populates="notes")

