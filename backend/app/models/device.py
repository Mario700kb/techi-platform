from datetime import timedelta
from enum import Enum
from sqlalchemy import JSON, Boolean, Column, DateTime, Enum as SQLEnum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.core.time import ensure_utc, utcnow


class DeviceType(str, Enum):
    SERVER = "server"
    CLIENT = "client"
    UNASSIGNED = "unassigned"


class DeviceStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"


class DeviceFreshnessState(str, Enum):
    ONLINE = "online"
    STALE = "stale"
    OFFLINE = "offline"


class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    rustdesk_id = Column(String(64), unique=True, nullable=True, index=True)
    agent_id = Column(String(80), unique=True, nullable=True, index=True)
    hostname = Column(String(128), nullable=True)
    display_name = Column(String(128), nullable=True)
    current_user = Column(String(128), nullable=True)
    user_source = Column(String(40), nullable=True)
    user_session_state = Column(String(40), nullable=True)
    domain = Column(String(128), nullable=True)
    public_ip = Column(String(45), nullable=True)
    local_ip = Column(String(45), nullable=True)
    os_name = Column(String(80), nullable=True)
    os_version = Column(String(80), nullable=True)
    os_caption = Column(String(160), nullable=True)
    os_build = Column(String(80), nullable=True)
    windows_product_type = Column(Integer, nullable=True)
    platform = Column(String(80), nullable=True)
    # Operator-set Connect target. Both nullable: when unset, the launcher falls
    # back to the reported addresses (see connect.py `resolve_connect_host`).
    # They exist because the reported IPs cannot express two real situations —
    # a router reached over the office VPN on its LAN address, and a management
    # service moved off its default port (Winbox on 8292/8293 rather than 8291).
    connect_host = Column(String(255), nullable=True)
    connect_port = Column(Integer, nullable=True)
    device_type = Column(SQLEnum(DeviceType), default=DeviceType.UNASSIGNED, nullable=False)
    status = Column(SQLEnum(DeviceStatus), default=DeviceStatus.OFFLINE, nullable=False)
    registered_at = Column(DateTime, default=utcnow, nullable=False)
    last_seen = Column(DateTime, nullable=True)
    last_enrollment_at = Column(DateTime, nullable=True)
    enrollment_count = Column(Integer, default=0, nullable=False)
    reenrolled_from_agent_id = Column(String(80), nullable=True)
    cpu = Column(String(120), nullable=True)
    ram = Column(String(120), nullable=True)
    storage = Column(String(120), nullable=True)
    # Platform Expansion (PLATFORM-EXPANSION-AUDIT.md §8) — additive, nullable,
    # populated only by platform-aware agents; always absent for today's fleet.
    fqdn = Column(String(255), nullable=True)
    kernel_version = Column(String(120), nullable=True)
    architecture = Column(String(40), nullable=True)
    mac_address = Column(String(64), nullable=True)
    timezone = Column(String(64), nullable=True)
    last_boot_at = Column(DateTime, nullable=True)
    capabilities = Column(JSON, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    is_archived = Column(Boolean, default=False, nullable=False)
    archived_at = Column(DateTime, nullable=True)
    archived_by = Column(String(128), nullable=True)
    rustdesk_install_status = Column(String(32), default="unknown", nullable=False)
    rustdesk_status = Column(String(32), default="unknown", nullable=False)
    rustdesk_version = Column(String(80), nullable=True)
    rustdesk_install_path = Column(String(512), nullable=True)
    rustdesk_last_seen_at = Column(DateTime, nullable=True)
    rustdesk_synced_at = Column(DateTime, nullable=True)
    rustdesk_sync_state = Column(String(32), default="unknown", nullable=False)
    rustdesk_sync_message = Column(String(255), nullable=True)
    rustdesk_verified_at = Column(DateTime, nullable=True)
    rustdesk_manual_override = Column(Boolean, default=False, nullable=False)
    rustdesk_conflict_detected = Column(Boolean, default=False, nullable=False)
    rustdesk_last_repair_at = Column(DateTime, nullable=True)
    rustdesk_repair_count = Column(Integer, default=0, nullable=False)

    duplicate_candidate = Column(Boolean, default=False, nullable=False)
    duplicate_of_device_id = Column(Integer, nullable=True)
    duplicate_score = Column(Float, nullable=True)

    # Offline reason engine — populated by agent or inferred by backend
    offline_reason = Column(String(64), nullable=True)        # shutdown|restart|sleep|hibernate|network_lost|agent_stopped|rs_stopped|unknown
    offline_confidence = Column(String(16), nullable=True)    # high|medium|low
    last_boot_time = Column(DateTime, nullable=True)
    last_shutdown_time = Column(DateTime, nullable=True)
    network_disconnect_time = Column(DateTime, nullable=True)

    is_in_maintenance = Column(Boolean, default=False, nullable=False)
    maintenance_started_at = Column(DateTime, nullable=True)
    maintenance_ends_at = Column(DateTime, nullable=True)
    maintenance_note = Column(String(255), nullable=True)
    maintenance_started_by = Column(String(128), nullable=True)

    agent_version = Column(String(20), nullable=True)
    agent_sha256 = Column(String(64), nullable=True)

    # Per-device TECHI Remote Support (RustDesk) permanent password, encrypted
    # at rest. Server-generated unique value (or operator-set custom). Replaces
    # the fleet-wide shared password so one device compromise can't expose all.
    remote_support_password_ciphertext = Column(Text, nullable=True)
    remote_support_password_updated_at = Column(DateTime, nullable=True)
    remote_support_password_source = Column(String(16), nullable=True)  # "generated" | "custom"

    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    group_id = Column(Integer, ForeignKey("device_groups.id"), nullable=True)
    auto_assigned = Column(Boolean, default=False, nullable=False)
    assignment_source = Column(String(40), default="manual", nullable=False)

    client = relationship("Client", back_populates="devices")
    group = relationship("DeviceGroup", back_populates="devices")
    heartbeats = relationship("DeviceHeartbeat", back_populates="device")
    remote_actions = relationship("RemoteAction", back_populates="device", cascade="all, delete-orphan")
    notes = relationship("DeviceNote", back_populates="device", cascade="all, delete-orphan")

    @property
    def client_name(self):
        return self.client.name if self.client else None

    @property
    def group_name(self):
        return self.group.name if self.group else None

    @property
    def freshness_state(self):
        if not self.last_seen:
            return DeviceFreshnessState.OFFLINE.value
        age = ensure_utc(utcnow()) - ensure_utc(self.last_seen)
        if age <= timedelta(minutes=6):
            return DeviceFreshnessState.ONLINE.value
        if age <= timedelta(minutes=25):
            return DeviceFreshnessState.STALE.value
        return DeviceFreshnessState.OFFLINE.value
