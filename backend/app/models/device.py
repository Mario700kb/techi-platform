from datetime import datetime
from enum import Enum
from sqlalchemy import Boolean, Column, DateTime, Enum as SQLEnum, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base


class DeviceType(str, Enum):
    SERVER = "server"
    CLIENT = "client"
    UNASSIGNED = "unassigned"


class DeviceStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"


class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    rustdesk_id = Column(String(64), unique=True, nullable=False, index=True)
    hostname = Column(String(128), nullable=True)
    current_user = Column(String(128), nullable=True)
    domain = Column(String(128), nullable=True)
    public_ip = Column(String(45), nullable=True)
    local_ip = Column(String(45), nullable=True)
    os_name = Column(String(80), nullable=True)
    os_version = Column(String(80), nullable=True)
    platform = Column(String(80), nullable=True)
    device_type = Column(SQLEnum(DeviceType), default=DeviceType.UNASSIGNED, nullable=False)
    status = Column(SQLEnum(DeviceStatus), default=DeviceStatus.OFFLINE, nullable=False)
    registered_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen = Column(DateTime, nullable=True)
    cpu = Column(String(120), nullable=True)
    ram = Column(String(120), nullable=True)
    storage = Column(String(120), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)

    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    group_id = Column(Integer, ForeignKey("device_groups.id"), nullable=True)

    client = relationship("Client", back_populates="devices")
    group = relationship("DeviceGroup", back_populates="devices")
    heartbeats = relationship("DeviceHeartbeat", back_populates="device")
