from enum import Enum

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text

from app.core.time import utcnow
from app.db.base import Base


class NotificationChannelType(str, Enum):
    EMAIL = "email"
    WEBHOOK = "webhook"
    # Future: SLACK, TEAMS, TELEGRAM, DISCORD, PAGERDUTY — new sender class +
    # one CHANNEL_SENDERS registry entry (app/services/notification_channels.py),
    # no change to NotificationService.dispatch() or this model.


class NotificationScopeType(str, Enum):
    GLOBAL = "global"
    CLIENT = "client"


class NotificationDeliveryStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"
    RETRYING = "retrying"
    FAILED = "failed"


class NotificationSeverity(str, Enum):
    """Ordering (index) is used by NotificationRule.min_severity filtering."""
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


SEVERITY_ORDER = [
    NotificationSeverity.INFO.value,
    NotificationSeverity.WARNING.value,
    NotificationSeverity.CRITICAL.value,
]


class NotificationChannel(Base):
    """A configured delivery target (Email or Webhook today).

    `config_json` holds the non-secret, channel-type-specific shape (SMTP
    host/port/tls/from/to for email; url/headers for webhook) — justified as
    a JSON blob because the shape genuinely varies per channel type and must
    stay extensible to future channel types without a schema migration.
    The one sensitive value per channel (SMTP password / webhook shared
    secret) is stored separately, AES-256-GCM encrypted via the same cipher
    the Credential Vault uses (app/core/vault_cipher.py) — reused directly,
    not duplicated.
    """

    __tablename__ = "notification_channels"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(160), nullable=False)
    channel_type = Column(String(24), nullable=False, index=True)  # NotificationChannelType
    enabled = Column(Boolean, nullable=False, default=True)
    config_json = Column(Text, nullable=False)  # non-secret config, JSON-encoded
    secret_ciphertext = Column(Text, nullable=True)
    secret_dek_wrapped = Column(Text, nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class NotificationRule(Base):
    """Binds an event type (+ optional client scope) to one channel, with
    severity filtering, cooldown, and a rolling rate limit. One row per
    (event_type, scope, channel) — multiple rules can target the same event
    across different channels/scopes."""

    __tablename__ = "notification_rules"

    id = Column(Integer, primary_key=True, index=True)
    event_type = Column(String(64), nullable=False, index=True)  # free string — new event types need no migration
    scope_type = Column(String(16), nullable=False, default=NotificationScopeType.GLOBAL.value, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    channel_id = Column(Integer, ForeignKey("notification_channels.id", ondelete="CASCADE"), nullable=False, index=True)
    enabled = Column(Boolean, nullable=False, default=True)
    min_severity = Column(String(16), nullable=True)  # NotificationSeverity; None = no filter
    cooldown_seconds = Column(Integer, nullable=False, default=0)
    rate_limit_per_hour = Column(Integer, nullable=True)  # None = unlimited
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class NotificationDelivery(Base):
    """One attempt/record per (rule, event occurrence) — also the retry
    queue (PENDING/RETRYING rows with next_retry_at) and the delivery
    history the UI reads. Test sends have rule_id=None."""

    __tablename__ = "notification_deliveries"

    id = Column(Integer, primary_key=True, index=True)
    rule_id = Column(Integer, ForeignKey("notification_rules.id", ondelete="SET NULL"), nullable=True, index=True)
    channel_id = Column(Integer, ForeignKey("notification_channels.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String(64), nullable=False, index=True)
    device_id = Column(Integer, nullable=True, index=True)
    client_id = Column(Integer, nullable=True, index=True)
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)
    payload_json = Column(Text, nullable=True)  # event-specific context; shape varies per event_type, justified
    status = Column(String(16), nullable=False, default=NotificationDeliveryStatus.PENDING.value, index=True)
    attempt_count = Column(Integer, nullable=False, default=0)
    last_error = Column(String(1024), nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False, index=True)
    sent_at = Column(DateTime, nullable=True)
    next_retry_at = Column(DateTime, nullable=True, index=True)
