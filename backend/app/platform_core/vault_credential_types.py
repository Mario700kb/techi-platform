"""Credential Type Registry — Enterprise Vault (2026-07-10).

The single source of truth for every credential type the Vault can store:
its non-secret metadata fields (persisted as `vault_credentials.metadata_json`,
never secret), its secret fields (JSON-encoded then AES-256-GCM encrypted —
same envelope as before, see app/core/vault_cipher.py), and which future
integrations it's meant for. One metadata-driven frontend form renders from
this registry instead of per-type hardcoded forms.

Legacy types (password/ssh_key/snmp/certificate, Phase 4 2026-07-07) are kept
byte-identical in id and get lightweight registry entries so every existing
row keeps resolving — no data migration. New types are additive.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class VaultFieldSpec:
    key: str
    label: str
    required: bool = False
    kind: str = "text"  # text|password|textarea|number|select
    options: Optional[Tuple[str, ...]] = None
    default: Optional[str] = None
    placeholder: Optional[str] = None


@dataclass(frozen=True)
class VaultCredentialTypeDescriptor:
    id: str
    label: str
    icon: str  # lucide-react icon name, resolved on the frontend
    category: str  # ssh|windows|network|api|notifications|snmp|generic
    metadata_fields: Tuple[VaultFieldSpec, ...] = field(default_factory=tuple)
    secret_fields: Tuple[VaultFieldSpec, ...] = field(default_factory=tuple)
    requires_username: bool = False
    future_consumers: Tuple[str, ...] = field(default_factory=tuple)
    legacy: bool = False

    @property
    def requires_secret(self) -> bool:
        return any(f.required for f in self.secret_fields)


_PORT = lambda default: VaultFieldSpec(key="port", label="Port", kind="number", default=default)  # noqa: E731

VAULT_CREDENTIAL_TYPES: Dict[str, VaultCredentialTypeDescriptor] = {
    "ssh_password": VaultCredentialTypeDescriptor(
        id="ssh_password", label="SSH (username/password)", icon="Terminal", category="ssh",
        metadata_fields=(_PORT("22"),),
        secret_fields=(VaultFieldSpec(key="password", label="Password", required=True, kind="password"),),
        requires_username=True,
        future_consumers=("SSH Relay", "Embedded Terminal"),
    ),
    "ssh_private_key": VaultCredentialTypeDescriptor(
        id="ssh_private_key", label="SSH (private key)", icon="KeyRound", category="ssh",
        metadata_fields=(_PORT("22"),),
        secret_fields=(
            VaultFieldSpec(key="private_key", label="Private key", required=True, kind="textarea"),
            VaultFieldSpec(key="passphrase", label="Passphrase (optional)", required=False, kind="password"),
        ),
        requires_username=True,
        future_consumers=("SSH Relay", "Embedded Terminal"),
    ),
    "windows_admin": VaultCredentialTypeDescriptor(
        id="windows_admin", label="Windows administrator", icon="MonitorCog", category="windows",
        secret_fields=(VaultFieldSpec(key="password", label="Password", required=True, kind="password"),),
        requires_username=True,
        future_consumers=("Windows Administration",),
    ),
    "winbox": VaultCredentialTypeDescriptor(
        id="winbox", label="Winbox", icon="Router", category="network",
        metadata_fields=(_PORT("8291"),),
        secret_fields=(VaultFieldSpec(key="password", label="Password", required=True, kind="password"),),
        requires_username=True,
        future_consumers=("Winbox Connect",),
    ),
    "webfig": VaultCredentialTypeDescriptor(
        id="webfig", label="WebFig", icon="Globe", category="network",
        metadata_fields=(_PORT("80"),),
        secret_fields=(VaultFieldSpec(key="password", label="Password", required=True, kind="password"),),
        requires_username=True,
        future_consumers=("WebFig Connect",),
    ),
    "api_token": VaultCredentialTypeDescriptor(
        id="api_token", label="API token", icon="Key", category="api",
        secret_fields=(VaultFieldSpec(key="token", label="Token", required=True, kind="password"),),
        future_consumers=("API Integration",),
    ),
    "smtp": VaultCredentialTypeDescriptor(
        id="smtp", label="SMTP", icon="Mail", category="notifications",
        metadata_fields=(
            VaultFieldSpec(key="host", label="Host", required=True),
            VaultFieldSpec(key="port", label="Port", required=True, kind="number", default="587"),
            VaultFieldSpec(key="tls_mode", label="TLS mode", kind="select",
                           options=("none", "starttls", "tls"), default="starttls"),
        ),
        secret_fields=(VaultFieldSpec(key="password", label="Password (optional)", kind="password"),),
        future_consumers=("Notifications SMTP",),
    ),
    "webhook_secret": VaultCredentialTypeDescriptor(
        id="webhook_secret", label="Webhook", icon="Webhook", category="notifications",
        metadata_fields=(VaultFieldSpec(key="url", label="Webhook URL", required=True),),
        secret_fields=(VaultFieldSpec(key="secret", label="Shared secret", required=True, kind="password"),),
        future_consumers=("Generic Webhook",),
    ),
    "snmp_v2": VaultCredentialTypeDescriptor(
        id="snmp_v2", label="SNMP v2c", icon="Radio", category="snmp",
        metadata_fields=(_PORT("161"),),
        secret_fields=(VaultFieldSpec(key="community", label="Community", required=True, kind="password"),),
        future_consumers=("SNMP Monitoring",),
    ),
    "snmp_v3": VaultCredentialTypeDescriptor(
        id="snmp_v3", label="SNMP v3", icon="Radio", category="snmp",
        metadata_fields=(
            _PORT("161"),
            VaultFieldSpec(key="auth_protocol", label="Auth protocol", kind="select", options=("MD5", "SHA"), default="SHA"),
            VaultFieldSpec(key="privacy_protocol", label="Privacy protocol", kind="select", options=("DES", "AES"), default="AES"),
        ),
        secret_fields=(
            VaultFieldSpec(key="auth_secret", label="Auth secret", required=True, kind="password"),
            VaultFieldSpec(key="privacy_secret", label="Privacy secret", required=True, kind="password"),
        ),
        requires_username=True,
        future_consumers=("SNMP Monitoring",),
    ),
    "generic_username_password": VaultCredentialTypeDescriptor(
        id="generic_username_password", label="Generic username/password", icon="UserCog", category="generic",
        secret_fields=(VaultFieldSpec(key="password", label="Password", required=True, kind="password"),),
        requires_username=True,
        future_consumers=("Other",),
    ),
    # Legacy (Phase 4, 2026-07-07) — kept for existing rows, hidden from the
    # "create new" type picker by the frontend (registry flag `legacy=True`).
    "password": VaultCredentialTypeDescriptor(
        id="password", label="Password (legacy)", icon="KeyRound", category="generic",
        secret_fields=(VaultFieldSpec(key="secret", label="Password", required=True, kind="password"),),
        requires_username=True, legacy=True,
        future_consumers=("Other",),
    ),
    "ssh_key": VaultCredentialTypeDescriptor(
        id="ssh_key", label="SSH key (legacy)", icon="KeyRound", category="ssh",
        secret_fields=(VaultFieldSpec(key="secret", label="Private key", required=True, kind="textarea"),),
        requires_username=True, legacy=True,
        future_consumers=("SSH Relay", "Embedded Terminal"),
    ),
    "snmp": VaultCredentialTypeDescriptor(
        id="snmp", label="SNMP (legacy)", icon="Radio", category="snmp",
        secret_fields=(VaultFieldSpec(key="secret", label="Community", required=True, kind="password"),),
        legacy=True,
        future_consumers=("SNMP Monitoring",),
    ),
    "certificate": VaultCredentialTypeDescriptor(
        id="certificate", label="Certificate (legacy)", icon="FileKey", category="generic",
        secret_fields=(VaultFieldSpec(key="secret", label="Certificate", required=True, kind="textarea"),),
        legacy=True,
        future_consumers=("Other",),
    ),
}


def get_type(type_id: str) -> Optional[VaultCredentialTypeDescriptor]:
    return VAULT_CREDENTIAL_TYPES.get(type_id)


def list_types(include_legacy: bool = True) -> List[VaultCredentialTypeDescriptor]:
    types = VAULT_CREDENTIAL_TYPES.values()
    if not include_legacy:
        types = [t for t in types if not t.legacy]
    return sorted(types, key=lambda t: (t.legacy, t.category, t.label))


class VaultCredentialTypeError(ValueError):
    pass


def validate_secret_fields(type_id: str, secret_fields: Dict[str, str]) -> Dict[str, str]:
    """Returns the cleaned secret-field dict (unknown keys dropped) or raises
    VaultCredentialTypeError if a required secret field is missing/blank."""
    descriptor = get_type(type_id)
    if descriptor is None:
        raise VaultCredentialTypeError(f"Unknown credential type '{type_id}'")
    known = {f.key for f in descriptor.secret_fields}
    cleaned = {k: v for k, v in secret_fields.items() if k in known and v}
    for f in descriptor.secret_fields:
        if f.required and not cleaned.get(f.key):
            raise VaultCredentialTypeError(f"'{f.label}' is required for {descriptor.label}")
    return cleaned


def validate_metadata(type_id: str, metadata: Dict[str, str]) -> Dict[str, str]:
    """Returns the cleaned metadata dict (unknown keys dropped) or raises
    VaultCredentialTypeError if a required metadata field is missing/blank."""
    descriptor = get_type(type_id)
    if descriptor is None:
        raise VaultCredentialTypeError(f"Unknown credential type '{type_id}'")
    known = {f.key for f in descriptor.metadata_fields}
    cleaned = {k: v for k, v in metadata.items() if k in known and v is not None and v != ""}
    for f in descriptor.metadata_fields:
        if f.required and not cleaned.get(f.key):
            raise VaultCredentialTypeError(f"'{f.label}' is required for {descriptor.label}")
    return cleaned
