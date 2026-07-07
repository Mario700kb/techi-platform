from datetime import datetime
from enum import Enum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text

from app.db.base import Base
from app.core.time import utcnow


class VaultCredentialType(str, Enum):
    PASSWORD = "password"
    SSH_KEY = "ssh_key"
    API_TOKEN = "api_token"
    SNMP = "snmp"
    WINBOX = "winbox"
    CERTIFICATE = "certificate"


class VaultScopeType(str, Enum):
    GLOBAL = "global"
    CLIENT = "client"
    GROUP = "group"
    DEVICE = "device"


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
