from datetime import datetime
from enum import Enum

from sqlalchemy import Column, DateTime, Enum as SQLEnum, ForeignKey, Index, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base


class AlertSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class AlertState(str, Enum):
    OPEN = "open"
    RESOLVED = "resolved"


class AlertKind(str, Enum):
    DEVICE_OFFLINE = "device_offline"
    REPEATED_RECONNECTS = "repeated_reconnects"
    HIGH_CPU = "high_cpu"
    HIGH_RAM = "high_ram"
    LOW_DISK = "low_disk"
    RUSTDESK_SYNC_FAILURE = "rustdesk_sync_failure"
    HEARTBEAT_STALE = "heartbeat_stale"
    TELEMETRY_MISSING = "telemetry_missing"
    ARCHIVED_CHECKIN = "archived_checkin"


class DeviceAlert(Base):
    __tablename__ = "device_alerts"
    __table_args__ = (
        Index("ix_device_alerts_device_kind_state", "device_id", "kind", "state"),
    )

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False, index=True)
    kind = Column(SQLEnum(AlertKind, native_enum=False, create_constraint=False, values_callable=lambda x: [e.value for e in x]), nullable=False, index=True)
    severity = Column(SQLEnum(AlertSeverity, native_enum=False, create_constraint=False, values_callable=lambda x: [e.value for e in x]), nullable=False)
    state = Column(SQLEnum(AlertState, native_enum=False, create_constraint=False, values_callable=lambda x: [e.value for e in x]), default=AlertState.OPEN, nullable=False, index=True)
    message = Column(String(512), nullable=False)
    detail = Column(String(1024), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    resolved_at = Column(DateTime, nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    cooldown_until = Column(DateTime, nullable=True)

    device = relationship("Device")
