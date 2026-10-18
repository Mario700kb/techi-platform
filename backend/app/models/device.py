from datetime import timedelta
from enum import Enum
from sqlalchemy import JSON, Boolean, Column, DateTime, Enum as SQLEnum, Float, ForeignKey, Integer, String, Text, and_, event, false, func, not_, or_, text
from sqlalchemy.orm import relationship
from sqlalchemy.orm.base import NO_VALUE

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

    id = Column(Integer, primary_key=True)
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
    # The password before the last change, still what the agent holds until
    # its next heartbeat delivers the new one; Connect uses it until then.
    remote_support_password_previous_ciphertext = Column(Text, nullable=True)
    # A live Remote Support session, as reported by agents that send
    # remote_session_active (from 2.1.24); older agents leave it False.
    rustdesk_session_active = Column(Boolean, default=False, server_default=text("false"), nullable=False)
    rustdesk_session_started_at = Column(DateTime, nullable=True)
    rustdesk_session_operator = Column(String(128), nullable=True)
    # Which writer owns the current/last session: "rustdesk" (its own
    # /api/audit/conn reports, second-accurate) or "heartbeat" (the agent's
    # coarse per-beat flag). RustDesk reports win; a heartbeat yields while
    # RustDesk is reporting. rustdesk_last_report_at marks the last such report.
    rustdesk_session_source = Column(String(16), nullable=True)
    rustdesk_last_report_at = Column(DateTime, nullable=True)

    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    group_id = Column(Integer, ForeignKey("device_groups.id"), nullable=True)
    auto_assigned = Column(Boolean, default=False, nullable=False)
    assignment_source = Column(String(40), default="manual", nullable=False)
    # The client's site the device is at: set by a location rule ("rule") or
    # by an operator ("manual", which the rules never move).
    location_id = Column(Integer, ForeignKey("client_locations.id", ondelete="SET NULL"), nullable=True, index=True)
    location_source = Column(String(16), nullable=True)

    # Joined: every heartbeat reads client_name/group_name, and each commit in
    # the heartbeat path expires the device, so lazy loading re-selected the
    # client and the group after every commit — 6 of a heartbeat's 17
    # queries, ~135M scans of these two small tables in production. Joined,
    # the device's own refresh brings both along.
    client = relationship("Client", back_populates="devices", lazy="joined")
    group = relationship("DeviceGroup", back_populates="devices", lazy="joined")
    # Joined for the same reason as client and group; a small table.
    location = relationship("ClientLocation", lazy="joined")
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
    def _own_location(self):
        # A location of another client (the device moved) does not count.
        if self.location and self.location.client_id == self.client_id:
            return self.location
        return None

    @property
    def location_name(self):
        return self._own_location.name if self._own_location else None

    @property
    def location_city(self):
        return self._own_location.city if self._own_location else None

    @property
    def location_country(self):
        return self._own_location.country if self._own_location else None

    @property
    def live(self) -> bool:
        """The agent holds its command channel open right now."""
        from app.websocket.agent_channel import agent_command_channel

        return self.id is not None and agent_command_channel.is_connected(self.id)

    @property
    def live_lost_at(self):
        """When the channel dropped, while the grace period that decides
        whether the device is offline runs; None otherwise."""
        from app.websocket.agent_channel import agent_command_channel

        return agent_command_channel.lost_since(self.id) if self.id is not None else None

    @property
    def freshness_state(self):
        return freshness_for(self.last_seen, self.status, self.offline_reason, live=self.live)


@event.listens_for(Device.client_id, "set", active_history=True)
def _leave_location_with_the_client(target, value, oldvalue, _initiator):
    """A device that moves to another client leaves its old client's site; the
    new client's rules place it again."""
    if oldvalue is not NO_VALUE and oldvalue != value:
        target.location_id = None
        target.location_source = None


ONLINE_WINDOW = timedelta(minutes=6)
STALE_WINDOW = timedelta(minutes=25)

# Offline the platform knows of rather than infers: the agent said it was
# shutting down or going to sleep, or its live connection dropped and did not
# come back. Shown as offline at once, everywhere, instead of the device
# ageing through "online" and "stale" for up to 25 minutes. A heartbeat clears
# it (mark_online_from_heartbeat resets offline_reason).
EXPLICIT_OFFLINE_REASONS = ("shutdown", "sleep", "connection_lost")


def _is_status(value, status) -> bool:
    return getattr(value, "value", value) == status.value


def freshness_for(last_seen, status=None, offline_reason=None, live=False) -> str:
    """online / stale / offline, the one rule every screen uses. The frontend
    mirrors it (frontend/src/utils/devicePresence.ts, kept equal by
    tests/test_status_realtime.py) to move rows on time between events."""
    if _is_status(status, DeviceStatus.OFFLINE) and offline_reason in EXPLICIT_OFFLINE_REASONS:
        return DeviceFreshnessState.OFFLINE.value
    if live:
        # An open channel is the agent running now, however late its
        # heartbeat (reconciliation skips such devices for the same reason).
        return DeviceFreshnessState.ONLINE.value
    if not last_seen:
        return DeviceFreshnessState.OFFLINE.value
    age = ensure_utc(utcnow()) - ensure_utc(last_seen)
    if age <= ONLINE_WINDOW:
        return DeviceFreshnessState.ONLINE.value
    if age <= STALE_WINDOW:
        return DeviceFreshnessState.STALE.value
    return DeviceFreshnessState.OFFLINE.value


def next_freshness_change(oldest_online, oldest_stale):
    """When a count next changes by time alone: the oldest heartbeat still
    online turns ONLINE_WINDOW old, or the oldest stale one STALE_WINDOW.
    None when no device moves by time."""
    moments = []
    if oldest_online is not None:
        moments.append(ensure_utc(oldest_online) + ONLINE_WINDOW)
    if oldest_stale is not None:
        moments.append(ensure_utc(oldest_stale) + STALE_WINDOW)
    return min(moments) if moments else None


def freshness_conditions(now, live_ids=(), dialect_name: str = "postgresql"):
    """SQL conditions for online, stale and offline — the same rules as
    freshness_for, so lists, filters and counts never disagree with a
    device's own state. coalesce keeps a NULL offline_reason from turning
    NOT(...) into NULL, which would drop the device from every bucket.
    live_ids are the devices with an open channel (online whatever their
    last heartbeat); none, and the conditions are the time windows alone."""
    from app.db.sql import id_in

    explicit = and_(
        Device.status == DeviceStatus.OFFLINE,
        func.coalesce(Device.offline_reason, "").in_(EXPLICIT_OFFLINE_REASONS),
    )
    live_ids = list(live_ids or ())
    live = id_in(Device.id, live_ids, dialect_name) if live_ids else false()
    online_cutoff = now - ONLINE_WINDOW
    stale_cutoff = now - STALE_WINDOW
    online = and_(or_(Device.last_seen >= online_cutoff, live), not_(explicit))
    stale = and_(Device.last_seen >= stale_cutoff, Device.last_seen < online_cutoff, not_(live), not_(explicit))
    offline = or_(and_(or_(Device.last_seen.is_(None), Device.last_seen < stale_cutoff), not_(live)), explicit)
    return online, stale, offline
