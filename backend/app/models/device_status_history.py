
from sqlalchemy import Column, DateTime, Enum as SQLEnum, ForeignKey, Index, Integer, String

from app.db.base import Base
from app.models.device import DeviceStatus
from app.core.time import utcnow_naive


class DeviceStatusHistory(Base):
    __tablename__ = "device_status_history"
    # (device_id, created_at): "each device's last or first transition around
    # a point in time", the dashboard trends' access pattern. It replaces the
    # device_id-only index, which is its prefix.
    __table_args__ = (Index("ix_device_status_history_device_created", "device_id", "created_at"),)

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False)
    previous_status = Column(SQLEnum(DeviceStatus), nullable=True)
    new_status = Column(SQLEnum(DeviceStatus), nullable=False)
    reason = Column(String(160), nullable=False)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False, index=True)
