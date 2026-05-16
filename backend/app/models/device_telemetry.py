from datetime import datetime
from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer

from app.db.base import Base


class DeviceTelemetry(Base):
    __tablename__ = "device_telemetry"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False, index=True)
    cpu_percent = Column(Float, nullable=True)
    ram_percent = Column(Float, nullable=True)
    disk_percent = Column(Float, nullable=True)
    uptime_seconds = Column(Integer, nullable=True)
    heartbeat_latency_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
