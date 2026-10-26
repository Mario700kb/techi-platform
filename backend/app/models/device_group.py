from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.core.time import utcnow_naive


class DeviceGroup(Base):
    __tablename__ = "device_groups"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False, index=True)
    description = Column(String(255), nullable=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False)

    client = relationship("Client", back_populates="device_groups")
    devices = relationship("Device", back_populates="group")
