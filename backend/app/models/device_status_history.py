from datetime import datetime

from sqlalchemy import Column, DateTime, Enum as SQLEnum, ForeignKey, Integer, String

from app.db.base import Base
from app.models.device import DeviceStatus


class DeviceStatusHistory(Base):
    __tablename__ = "device_status_history"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False, index=True)
    previous_status = Column(SQLEnum(DeviceStatus), nullable=True)
    new_status = Column(SQLEnum(DeviceStatus), nullable=False)
    reason = Column(String(160), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
