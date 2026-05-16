from datetime import datetime
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base


class DeviceGroup(Base):
    __tablename__ = "device_groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False, index=True)
    description = Column(String(255), nullable=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    client = relationship("Client", back_populates="device_groups")
    devices = relationship("Device", back_populates="group")
