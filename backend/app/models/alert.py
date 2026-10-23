from enum import Enum

from sqlalchemy import Boolean, Column, Date, DateTime, Enum as SQLEnum, Float, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy import false as sa_false
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.core.time import utcnow_naive


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
    DISK_FORECAST = "disk_forecast"
    HIGH_NETWORK = "high_network"
    # Agent 2.1.33 and server-side health monitors.
    DISK_BUSY = "disk_busy"
    NETWORK_LATENCY = "network_latency"
    PACKET_LOSS = "packet_loss"
    SERVICE_STOPPED = "service_stopped"
    DISK_HEALTH = "disk_health"
    CRITICAL_EVENTS = "critical_events"
    REBOOT_PENDING = "reboot_pending"
    SECURITY_POSTURE = "security_posture"


class DeviceAlert(Base):
    __tablename__ = "device_alerts"
    __table_args__ = (
        Index("ix_device_alerts_device_kind_state", "device_id", "kind", "state"),
        # OfflineAlertSweep: "an offline alert opened since the last contact?"
        Index("ix_device_alerts_device_kind_created", "device_id", "kind", "created_at"),
        # The deadline sweep: open alerts whose next escalation step is due.
        Index("ix_device_alerts_open_next_check", "next_check_at",
              postgresql_where=text("state = 'open'"), sqlite_where=text("state = 'open'")),
    )

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False)
    kind = Column(SQLEnum(AlertKind, native_enum=False, create_constraint=False, values_callable=lambda x: [e.value for e in x]), nullable=False, index=True)
    severity = Column(SQLEnum(AlertSeverity, native_enum=False, create_constraint=False, values_callable=lambda x: [e.value for e in x]), nullable=False)
    state = Column(SQLEnum(AlertState, native_enum=False, create_constraint=False, values_callable=lambda x: [e.value for e in x]), default=AlertState.OPEN, nullable=False, index=True)
    message = Column(String(512), nullable=False)
    detail = Column(String(1024), nullable=True)
    # Indexed for the dashboard's 30-day alert trend (opened / resolved in window).
    created_at = Column(DateTime, default=utcnow_naive, nullable=False, index=True)
    updated_at = Column(DateTime, default=utcnow_naive, nullable=False)
    resolved_at = Column(DateTime, nullable=True, index=True)
    acknowledged_at = Column(DateTime, nullable=True)
    cooldown_until = Column(DateTime, nullable=True)
    # One open alert per (device, kind, fingerprint): the fingerprint names
    # what inside the device is affected ("svc:spooler", "vol:D:",
    # "evt:shutdown"), "" when the kind alone says it.
    fingerprint = Column(String(128), nullable=False, default="", server_default="")
    # A problem that comes back within a day reopens the same row: how many
    # times it has opened, and when it was last seen.
    occurrences = Column(Integer, nullable=False, default=1, server_default="1")
    last_seen_at = Column(DateTime, nullable=True)
    # 1 (act now) … 4 (whenever): severity weighed by the device's role.
    priority = Column(Integer, nullable=True, index=True)
    assigned_to_id = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True, index=True)
    snoozed_until = Column(DateTime, nullable=True)
    # Snoozed "until it gets worse": a higher severity wakes it.
    snooze_until_worse = Column(Boolean, nullable=False, default=False, server_default=sa_false())
    # auto | fixed | false_positive | expected | duplicate | muted
    resolution = Column(String(32), nullable=True)
    resolved_by = Column(String(128), nullable=True)
    # When an unowned P1 was last escalated (reminder notification).
    escalated_at = Column(DateTime, nullable=True)
    # Deadlines (app/services/alert_sla.py): stamped once when the alert opens
    # or reopens, so no read computes the working-hours calendar. The clock
    # starts at sla_started_at; time spent waiting on someone else is added
    # back as sla_paused_minutes. sla_24x7: a P1 on a server counts every hour.
    sla_started_at = Column(DateTime, nullable=True)
    ack_due_at = Column(DateTime, nullable=True)
    resolve_due_at = Column(DateTime, nullable=True)
    sla_24x7 = Column(Boolean, nullable=False, default=False, server_default=sa_false())
    sla_paused_minutes = Column(Integer, nullable=False, default=0, server_default="0")
    # The last escalation step taken (0 none … 4 deadline missed) and when the
    # next one is due: the sweep reads only rows whose next_check_at passed.
    sla_step = Column(Integer, nullable=False, default=0, server_default="0")
    next_check_at = Column(DateTime, nullable=True)
    # Work on it: the first note, waiting on the client / a vendor / a part.
    first_action_at = Column(DateTime, nullable=True)
    waiting_reason = Column(String(32), nullable=True)
    waiting_since = Column(DateTime, nullable=True)
    # One problem on several devices of a client: the first alert leads, the
    # others follow its owner and close with it.
    parent_id = Column(Integer, ForeignKey("device_alerts.id", ondelete="SET NULL"), nullable=True, index=True)
    # Came back 5 times in 7 days, or after a fix: closing it needs the cause.
    recurring = Column(Boolean, nullable=False, default=False, server_default=sa_false())

    device = relationship("Device")
    assigned_to = relationship("Operator", lazy="joined")


class AlertWaitingReason(str, Enum):
    CLIENT = "client"
    VENDOR = "vendor"
    PARTS = "parts"
    MAINTENANCE = "maintenance"


class AlertDutyShift(Base):
    """Who keeps the alert queue (the dispatcher) from one day to another,
    and who stands in. Days in the display time zone, both inclusive."""

    __tablename__ = "alert_duty_shifts"

    id = Column(Integer, primary_key=True)
    starts_on = Column(Date, nullable=False, index=True)
    ends_on = Column(Date, nullable=False, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id", ondelete="CASCADE"), nullable=False)
    backup_operator_id = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True)
    note = Column(String(200), nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)

    operator = relationship("Operator", foreign_keys=[operator_id], lazy="joined")
    backup = relationship("Operator", foreign_keys=[backup_operator_id], lazy="joined")


class AlertResolution(str, Enum):
    AUTO = "auto"
    FIXED = "fixed"
    FALSE_POSITIVE = "false_positive"
    EXPECTED = "expected"
    DUPLICATE = "duplicate"
    MUTED = "muted"


class AlertActivity(Base):
    """The timeline of one alert: opened, reopened, taken, snoozed, notes,
    resolved, analysed."""

    __tablename__ = "alert_activity"

    id = Column(Integer, primary_key=True)
    alert_id = Column(Integer, ForeignKey("device_alerts.id", ondelete="CASCADE"), nullable=False, index=True)
    at = Column(DateTime, default=utcnow_naive, nullable=False)
    actor = Column(String(128), nullable=True)  # operator username, or None for the platform
    action = Column(String(32), nullable=False)
    detail = Column(String(1000), nullable=True)


class AlertMute(Base):
    """A rule that keeps matching alerts from opening, until it expires."""

    __tablename__ = "alert_mutes"

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=True, index=True)
    kind = Column(String(64), nullable=True)
    fingerprint = Column(String(128), nullable=True)
    until = Column(DateTime, nullable=True)  # None: until removed
    reason = Column(String(500), nullable=False)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)
    removed_at = Column(DateTime, nullable=True)
    removed_by = Column(String(128), nullable=True)


class AlertAnalysis(Base):
    """An AI analysis of one alert (or of a group of the same alerts)."""

    __tablename__ = "alert_analyses"

    id = Column(Integer, primary_key=True)
    alert_id = Column(Integer, ForeignKey("device_alerts.id", ondelete="CASCADE"), nullable=True, index=True)
    group_key = Column(String(200), nullable=True, index=True)
    language = Column(String(8), nullable=False, default="sq")
    model = Column(String(64), nullable=False)
    result_json = Column(Text, nullable=True)
    error = Column(String(500), nullable=True)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    cost_usd = Column(Float, nullable=True)
    occurrences = Column(Integer, nullable=True)  # the alert's count when analysed
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False, index=True)
    rating = Column(Integer, nullable=True)  # 1 useful, -1 not useful
    rated_by = Column(String(128), nullable=True)
