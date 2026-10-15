from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer

from app.db.base import Base
from app.core.time import utcnow_naive


class DeviceTelemetry(Base):
    __tablename__ = "device_telemetry"

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False, index=True)
    cpu_percent = Column(Float, nullable=True)
    ram_percent = Column(Float, nullable=True)
    disk_percent = Column(Float, nullable=True)
    uptime_seconds = Column(Integer, nullable=True)
    heartbeat_latency_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False, index=True)
