from datetime import datetime
from enum import Enum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text

from app.db.base import Base
from app.core.time import utcnow


class VaultCredentialType(str, Enum):
    # Legacy values (Phase 4, 2026-07-07) — kept exactly as-is so every
    # existing row keeps resolving without a data migration.
    PASSWORD = "password"
    SSH_KEY = "ssh_key"
    API_TOKEN = "api_token"
    SNMP = "snmp"
    WINBOX = "winbox"
    CERTIFICATE = "certificate"
    # Enterprise Vault (2026-07-10) — additive. See the credential-type field
    # registry module vault_credential_types.py for validation rules.
    SSH_PASSWORD = "ssh_password"
    SSH_PRIVATE_KEY = "ssh_private_key"
    WINDOWS_ADMIN = "windows_admin"
    WEBFIG = "webfig"
    SMTP = "smtp"
    WEBHOOK_SECRET = "webhook_secret"
    SNMP_V2 = "snmp_v2"
    SNMP_V3 = "snmp_v3"
    GENERIC_USERNAME_PASSWORD = "generic_username_password"


class VaultScopeType(str, Enum):
    GLOBAL = "global"
    CLIENT = "client"
    GROUP = "group"
    DEVICE = "device"


class VaultCredentialStatus(str, Enum):
    ACTIVE = "active"
    DISABLED = "disabled"


class VaultCredential(Base):
    """Enterprise Credential Vault entry (Phase 4, audit §19).

    The secret itself lives only in `ciphertext` (AES-256-GCM under a
    per-credential DEK) with the DEK wrapped by the file-based master key —
    see app/core/vault_cipher.py. Fully separate from the RS-password system.
    """

    __tablename__ = "vault_credentials"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(160), nullable=False)
    credential_type = Column(String(32), nullable=False)  # VaultCredentialType values
    scope_type = Column(String(16), nullable=False, default=VaultScopeType.GLOBAL.value, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    group_id = Column(Integer, ForeignKey("device_groups.id"), nullable=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=True, index=True)
    username = Column(String(160), nullable=True)
    ciphertext = Column(Text, nullable=False)
    dek_wrapped = Column(Text, nullable=False)
    notes = Column(String(500), nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
    rotated_at = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    # Enterprise Vault (2026-07-10) — additive, all nullable/defaulted so every
    # existing row keeps working untouched.
    purpose = Column(String(64), nullable=True, index=True)  # e.g. "embedded_terminal", "notifications_smtp"
    status = Column(String(16), nullable=False, default=VaultCredentialStatus.ACTIVE.value, index=True)
    expires_at = Column(DateTime, nullable=True)
    rotation_due_at = Column(DateTime, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)
    last_test_status = Column(String(16), nullable=True)  # success|failed
    # Non-secret, type-specific fields (port, TLS mode, auth protocol, ...),
    # validated server-side against vault_credential_types.py before storage.
    # Never holds a secret value — those stay only in ciphertext/dek_wrapped.
    metadata_json = Column(Text, nullable=True)


class VaultCredentialUsage(Base):
    """Append-only usage audit: every use/reveal/test of a credential."""

    __tablename__ = "vault_credential_usage"

    id = Column(Integer, primary_key=True, index=True)
    credential_id = Column(Integer, ForeignKey("vault_credentials.id"), nullable=False, index=True)
    operator_username = Column(String(128), nullable=True)
    device_id = Column(Integer, nullable=True)
    action = Column(String(24), nullable=False)  # use|reveal|test|create|update|rotate|delete
    reason = Column(String(300), nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False, index=True)


class VaultCredentialAssignment(Base):
    """Enterprise Vault (2026-07-10) — explicit "also used by" references,
    separate from the credential's primary scope (scope_type/client_id/
    group_id/device_id). A Global credential can still be explicitly linked
    to specific clients/devices so its blast radius is documented and its
    deletion is guarded (see VaultService.blocking_references)."""

    __tablename__ = "vault_credential_assignments"

    id = Column(Integer, primary_key=True, index=True)
    credential_id = Column(Integer, ForeignKey("vault_credentials.id", ondelete="CASCADE"), nullable=False, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=True, index=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False, index=True)
