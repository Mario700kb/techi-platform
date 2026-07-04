from datetime import datetime
from enum import Enum
from sqlalchemy import Column, DateTime, Enum as SQLEnum, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.models.device import DeviceType, DeviceStatus


class DeviceHeartbeat(Base):
    __tablename__ = "device_heartbeats"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False, index=True)
    rustdesk_id = Column(String(64), nullable=True, index=True)
    hostname = Column(String(128), nullable=True)
    current_user = Column(String(128), nullable=True)
    domain = Column(String(128), nullable=True)
    public_ip = Column(String(45), nullable=True)
    local_ip = Column(String(45), nullable=True)
    os_name = Column(String(80), nullable=True)
    os_version = Column(String(80), nullable=True)
    os_caption = Column(String(160), nullable=True)
    os_build = Column(String(80), nullable=True)
    windows_product_type = Column(Integer, nullable=True)
    platform = Column(String(80), nullable=True)
    device_type = Column(SQLEnum(DeviceType), nullable=False, default=DeviceType.UNASSIGNED)
    status = Column(SQLEnum(DeviceStatus), nullable=False, default=DeviceStatus.ONLINE)
    cpu = Column(String(120), nullable=True)
    ram = Column(String(120), nullable=True)
    storage = Column(String(120), nullable=True)
    rustdesk_install_status = Column(String(32), nullable=True)
    rustdesk_status = Column(String(32), nullable=True)
    rustdesk_version = Column(String(80), nullable=True)
    rustdesk_install_path = Column(String(512), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    device = relationship("Device", back_populates="heartbeats")
