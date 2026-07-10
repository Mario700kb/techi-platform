"""Enterprise Credential Vault service (Phase 4, audit §19; extended
2026-07-10 into a full enterprise secret manager).

Rules enforced here:
  - secrets are stored only as AES-256-GCM envelope ciphertext (vault_cipher);
  - plaintext exists in memory only during use/reveal, never in logs/responses
    except the explicit, audited /reveal path;
  - every access writes an append-only vault_credential_usage row;
  - scope integrity: scope_type dictates exactly which target id must be set;
  - non-secret type-specific fields (port, TLS mode, ...) are validated
    against the credential-type registry and stored as metadata_json — never
    a secret value.

The Remote Support password system (secret_cipher) is untouched by design.
resolve_for_context() was built for a future integration to call; Embedded
SSH Connect (app/services/ssh_connector.py) is the first live consumer —
see resolve_ssh_candidates() below, which reuses the exact same Device >
Group > Client > Global precedence but returns every credential at the
first non-empty tier (not just one arbitrary pick) so a caller can offer a
selector when more than one applies at that tier.
"""

import json
import logging
from datetime import timedelta
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow
from app.core.vault_cipher import decrypt_secret, encrypt_secret
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.vault_credential import (
    VaultCredential,
    VaultCredentialAssignment,
    VaultCredentialStatus,
    VaultCredentialUsage,
    VaultScopeType,
)
from app.platform_core.vault_credential_types import (
    VaultCredentialTypeError,
    get_type,
    validate_metadata,
    validate_secret_fields,
)
from app.schemas.vault import VaultCredentialCreate, VaultCredentialUpdate

logger = logging.getLogger(__name__)

# Credential types with a real SSH secret (password or key) — the set
# resolve_ssh_candidates() considers. Includes the legacy ssh_key type so a
# pre-2026-07-10 credential works with Embedded SSH Connect with zero migration.
SSH_CREDENTIAL_TYPES = ("ssh_password", "ssh_private_key", "ssh_key")

_SCOPE_TARGET_FIELD = {
    VaultScopeType.GLOBAL.value: None,
    VaultScopeType.CLIENT.value: "client_id",
    VaultScopeType.GROUP.value: "group_id",
    VaultScopeType.DEVICE.value: "device_id",
}

# Window used only to derive the "expiring_soon" display badge — no
# automatic expiry/rotation action is performed anywhere in this release.
_EXPIRING_SOON_WINDOW = timedelta(days=14)


class VaultScopeError(ValueError):
    pass


class VaultReferencedError(ValueError):
    """Raised when a credential is scoped to a target that still exists, or
    has an explicit assignment, deleting it would silently remove access the
    operator may not realize is still in use. Carries the human-readable
    references for the 409 body."""

    def __init__(self, references: List[str]):
        self.references = references
        super().__init__("credential is still referenced")


class VaultService:
    def __init__(self, db: Session):
        self.db = db

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _validate_scope(scope_type: str, client_id, group_id, device_id) -> None:
        target_field = _SCOPE_TARGET_FIELD.get(scope_type)
        provided = {
            "client_id": client_id,
            "group_id": group_id,
            "device_id": device_id,
        }
        for field, value in provided.items():
            if field == target_field:
                if value is None:
                    raise VaultScopeError(f"scope '{scope_type}' requires {field}")
            elif value is not None:
                raise VaultScopeError(f"scope '{scope_type}' must not set {field}")

    @staticmethod
    def secret_hint(credential: VaultCredential) -> str:
        import hashlib

        digest = hashlib.sha256(
            f"{credential.id}:{credential.name}:{credential.rotated_at}".encode()
        ).hexdigest()
        return "••••" + digest[-4:]

    def _record_usage(
        self,
        credential_id: int,
        action: str,
        operator_username: Optional[str],
        reason: Optional[str] = None,
        device_id: Optional[int] = None,
    ) -> None:
        self.db.add(
            VaultCredentialUsage(
                credential_id=credential_id,
                operator_username=operator_username,
                device_id=device_id,
                action=action,
                reason=reason,
            )
        )
        self.db.commit()

    @staticmethod
    def _encode_secret_payload(secret_fields: Dict[str, str]) -> str:
        return json.dumps(secret_fields, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _decode_secret_payload(plaintext: str) -> Dict[str, str]:
        """New rows always store a JSON object of secret fields. Rows created
        before 2026-07-10 store the raw secret string directly (no JSON) —
        fall back to wrapping it under the legacy 'secret' key so every
        existing credential keeps revealing correctly with no re-encryption."""
        try:
            decoded = json.loads(plaintext)
            if isinstance(decoded, dict):
                return {str(k): str(v) for k, v in decoded.items()}
        except (json.JSONDecodeError, TypeError):
            pass
        return {"secret": plaintext}

    @staticmethod
    def _resolve_secret_fields(
        credential_type: str, secret: Optional[str], secret_fields: Optional[Dict[str, str]]
    ) -> Dict[str, str]:
        if secret_fields:
            return validate_secret_fields(credential_type, secret_fields)
        if secret is not None:
            descriptor = get_type(credential_type)
            if descriptor is None:
                raise VaultCredentialTypeError(f"Unknown credential type '{credential_type}'")
            if len(descriptor.secret_fields) == 1:
                return validate_secret_fields(credential_type, {descriptor.secret_fields[0].key: secret})
        return validate_secret_fields(credential_type, {})

    # -- CRUD --------------------------------------------------------------

    def create(self, data: VaultCredentialCreate, created_by: Optional[str]) -> VaultCredential:
        self._validate_scope(data.scope_type.value, data.client_id, data.group_id, data.device_id)
        credential_type = data.credential_type.value
        secret_fields = self._resolve_secret_fields(credential_type, data.secret, data.secret_fields)
        metadata = validate_metadata(credential_type, data.metadata or {})
        ciphertext, wrapped = encrypt_secret(self._encode_secret_payload(secret_fields))
        credential = VaultCredential(
            name=data.name,
            credential_type=credential_type,
            scope_type=data.scope_type.value,
            client_id=data.client_id,
            group_id=data.group_id,
            device_id=data.device_id,
            purpose=data.purpose,
            username=data.username,
            ciphertext=ciphertext,
            dek_wrapped=wrapped,
            notes=data.notes,
            created_by=created_by,
            expires_at=data.expires_at,
            rotation_due_at=data.rotation_due_at,
            metadata_json=json.dumps(metadata) if metadata else None,
        )
        self.db.add(credential)
        self.db.commit()
        self.db.refresh(credential)
        self._record_usage(credential.id, "create", created_by)
        return credential

    def list(self) -> List[VaultCredential]:
        return (
            self.db.query(VaultCredential)
            .order_by(VaultCredential.scope_type, VaultCredential.name)
            .all()
        )

    def get(self, credential_id: int) -> Optional[VaultCredential]:
        return self.db.query(VaultCredential).filter(VaultCredential.id == credential_id).first()

    def update(
        self, credential: VaultCredential, data: VaultCredentialUpdate, operator_username: Optional[str]
    ) -> VaultCredential:
        rotated = False
        if data.name is not None:
            credential.name = data.name
        if data.username is not None:
            credential.username = data.username
        if data.purpose is not None:
            credential.purpose = data.purpose
        if data.notes is not None:
            credential.notes = data.notes
        if data.expires_at is not None:
            credential.expires_at = data.expires_at
        if data.rotation_due_at is not None:
            credential.rotation_due_at = data.rotation_due_at
        if data.status is not None:
            if data.status not in (VaultCredentialStatus.ACTIVE.value, VaultCredentialStatus.DISABLED.value):
                raise VaultScopeError(f"invalid status '{data.status}'")
            credential.status = data.status
        if data.metadata is not None:
            metadata = validate_metadata(credential.credential_type, data.metadata)
            credential.metadata_json = json.dumps(metadata) if metadata else None
        if data.secret is not None or data.secret_fields:
            secret_fields = self._resolve_secret_fields(credential.credential_type, data.secret, data.secret_fields)
            credential.ciphertext, credential.dek_wrapped = encrypt_secret(self._encode_secret_payload(secret_fields))
            credential.rotated_at = utcnow()
            rotated = True
        self.db.commit()
        self.db.refresh(credential)
        self._record_usage(credential.id, "rotate" if rotated else "update", operator_username)
        return credential

    def set_status(
        self, credential: VaultCredential, status: str, operator_username: Optional[str]
    ) -> VaultCredential:
        if status not in (VaultCredentialStatus.ACTIVE.value, VaultCredentialStatus.DISABLED.value):
            raise VaultScopeError(f"invalid status '{status}'")
        credential.status = status
        self.db.commit()
        self.db.refresh(credential)
        self._record_usage(
            credential.id,
            "enable" if status == VaultCredentialStatus.ACTIVE.value else "disable",
            operator_username,
        )
        return credential

    def blocking_references(self, credential: VaultCredential) -> List[str]:
        """Human-readable references that still point at this credential —
        its primary scope target (if still alive) plus any explicit
        assignment. An orphaned scope (target already deleted) never blocks
        cleanup — only a target that's still alive does."""
        references: List[str] = []
        if credential.scope_type == VaultScopeType.CLIENT.value and credential.client_id is not None:
            client = self.db.query(Client).filter(Client.id == credential.client_id).first()
            if client is not None:
                references.append(f"Client #{client.id} ({client.name})")
        elif credential.scope_type == VaultScopeType.GROUP.value and credential.group_id is not None:
            group = self.db.query(DeviceGroup).filter(DeviceGroup.id == credential.group_id).first()
            if group is not None:
                references.append(f"Group #{group.id} ({group.name})")
        elif credential.scope_type == VaultScopeType.DEVICE.value and credential.device_id is not None:
            device = self.db.query(Device).filter(Device.id == credential.device_id).first()
            if device is not None:
                label = device.display_name or device.hostname or f"device #{device.id}"
                references.append(f"Device #{device.id} ({label})")

        for assignment in self.list_assignments(credential.id):
            if assignment.client_id is not None:
                client = self.db.query(Client).filter(Client.id == assignment.client_id).first()
                if client is not None:
                    references.append(f"Client #{client.id} ({client.name}) [assigned]")
            if assignment.device_id is not None:
                device = self.db.query(Device).filter(Device.id == assignment.device_id).first()
                if device is not None:
                    label = device.display_name or device.hostname or f"device #{device.id}"
                    references.append(f"Device #{device.id} ({label}) [assigned]")
        return references

    def delete(
        self,
        credential: VaultCredential,
        operator_username: Optional[str],
        force: bool = False,
    ) -> None:
        if not force:
            references = self.blocking_references(credential)
            if references:
                raise VaultReferencedError(references)
        credential_id = credential.id
        # vault_credential_usage.credential_id is a real, non-cascading FK in
        # production Postgres — every credential has at least one usage row
        # (the "create" entry), so deleting the credential first always hit a
        # ForeignKeyViolation (500, surfaced to the browser as "Failed to
        # fetch"). The append-only usage log has no ongoing value once the
        # credential itself is gone; the permanent deletion record lives in
        # AuditLog (written by the caller), which has no such FK.
        self.db.query(VaultCredentialUsage).filter(
            VaultCredentialUsage.credential_id == credential_id
        ).delete(synchronize_session=False)
        # vault_credential_assignments cascades at the DB level (ondelete=CASCADE).
        self.db.delete(credential)
        self.db.commit()

    # -- secret access -----------------------------------------------------

    def reveal(
        self, credential: VaultCredential, operator_username: Optional[str], reason: str
    ) -> Dict[str, str]:
        plaintext = decrypt_secret(credential.ciphertext, credential.dek_wrapped)
        credential.last_used_at = utcnow()
        self.db.commit()
        self._record_usage(credential.id, "reveal", operator_username, reason=reason)
        logger.warning(
            "VAULT REVEAL: credential #%d (%s) revealed to %s — reason: %s",
            credential.id,
            credential.name,
            operator_username,
            reason,
        )
        return self._decode_secret_payload(plaintext)

    def get_secret_fields_for_use(self, credential: VaultCredential) -> Dict[str, str]:
        """Decrypts a credential's secret fields for direct use by a live
        connection (Embedded SSH Connect) — distinct from reveal() (which is
        for showing plaintext to a human, requires vault_reveal + a reason,
        and writes a 'reveal' usage row). Does not write a usage row itself;
        the caller records a 'use' row via record_credential_use() only once
        the connection actually succeeds."""
        plaintext = decrypt_secret(credential.ciphertext, credential.dek_wrapped)
        return self._decode_secret_payload(plaintext)

    def usage(self, credential_id: int, limit: int = 100) -> List[VaultCredentialUsage]:
        return (
            self.db.query(VaultCredentialUsage)
            .filter(VaultCredentialUsage.credential_id == credential_id)
            .order_by(VaultCredentialUsage.created_at.desc())
            .limit(limit)
            .all()
        )

    # -- test connection -------------------------------------------------------

    def test_connection(self, credential: VaultCredential) -> "tuple[str, str]":
        """Returns (status, message), status one of success|failed|unsupported.
        Only SMTP and Webhook credentials have a real, existing client to test
        against (the Notification Engine's own senders/smtplib) — every other
        type honestly reports "unsupported" rather than faking a result (no
        SSH/SNMP/RouterOS client exists in this codebase yet)."""
        metadata = json.loads(credential.metadata_json) if credential.metadata_json else {}
        secret_fields = self._decode_secret_payload(decrypt_secret(credential.ciphertext, credential.dek_wrapped))

        if credential.credential_type == "smtp":
            return self._test_smtp(metadata, credential.username, secret_fields.get("password"))
        if credential.credential_type == "webhook_secret":
            return self._test_webhook(metadata, secret_fields.get("secret"))
        return (
            "unsupported",
            "Connection testing will become available when this credential type is connected to a supported integration.",
        )

    @staticmethod
    def _test_smtp(metadata: Dict[str, str], username: Optional[str], password: Optional[str]) -> "tuple[str, str]":
        import smtplib
        import socket

        host = metadata.get("host")
        if not host:
            return "failed", "SMTP credential is missing a host"
        try:
            port = int(metadata.get("port") or 587)
        except ValueError:
            return "failed", "SMTP port is not a valid number"
        tls_mode = metadata.get("tls_mode", "starttls")
        try:
            with smtplib.SMTP(host, port, timeout=10) as smtp:
                if tls_mode == "starttls":
                    smtp.starttls()
                if username and password:
                    smtp.login(username, password)
            return "success", f"Connected to {host}:{port}" + (" and authenticated" if username and password else "")
        except (smtplib.SMTPException, socket.error, OSError) as exc:
            return "failed", str(exc)

    @staticmethod
    def _test_webhook(metadata: Dict[str, str], secret: Optional[str]) -> "tuple[str, str]":
        from app.services.notification_channels import send_via_channel

        url = metadata.get("url")
        if not url:
            return "failed", "Webhook credential is missing a url"
        headers = {"X-TECHI-Vault-Test": "1"}
        ok, error = send_via_channel(
            "webhook",
            config={"url": url, "headers": headers},
            secret=secret,
            title="TECHI Vault connection test",
            message="This is a test ping from the TECHI Credential Vault.",
            event_type="vault_test",
        )
        return ("success", f"Webhook at {url} responded successfully") if ok else ("failed", error or "Webhook test failed")

    # -- assignments ---------------------------------------------------------

    def list_assignments(self, credential_id: int) -> List[VaultCredentialAssignment]:
        return (
            self.db.query(VaultCredentialAssignment)
            .filter(VaultCredentialAssignment.credential_id == credential_id)
            .order_by(VaultCredentialAssignment.created_at.desc())
            .all()
        )

    def add_assignment(
        self, credential_id: int, client_id: Optional[int], device_id: Optional[int], created_by: Optional[str]
    ) -> VaultCredentialAssignment:
        if not client_id and not device_id:
            raise VaultScopeError("assignment requires client_id or device_id")
        assignment = VaultCredentialAssignment(
            credential_id=credential_id, client_id=client_id, device_id=device_id, created_by=created_by,
        )
        self.db.add(assignment)
        self.db.commit()
        self.db.refresh(assignment)
        self._record_usage(credential_id, "assign", created_by)
        return assignment

    def remove_assignment(self, assignment: VaultCredentialAssignment, operator_username: Optional[str]) -> None:
        credential_id = assignment.credential_id
        self.db.delete(assignment)
        self.db.commit()
        self._record_usage(credential_id, "unassign", operator_username)

    # -- scope resolution (for future consumers — not called automatically) -

    def resolve_for_context(
        self,
        *,
        purpose: Optional[str] = None,
        device_id: Optional[int] = None,
        group_id: Optional[int] = None,
        client_id: Optional[int] = None,
    ) -> Optional[VaultCredential]:
        """Single source of truth for future SSH/SNMP/Connect consumers:
        resolves the single most-specific ACTIVE credential for a context,
        precedence Device > Group > Client > Global. Not wired into any live
        connection path yet — this method exists so that when one is built,
        it has one place to ask "which credential applies here," rather than
        each integration re-inventing scope precedence.
        """
        query = self.db.query(VaultCredential).filter(
            VaultCredential.status == VaultCredentialStatus.ACTIVE.value
        )
        if purpose is not None:
            query = query.filter(VaultCredential.purpose == purpose)
        candidates = query.all()
        by_scope: Dict[str, VaultCredential] = {}
        for cred in candidates:
            if cred.scope_type == VaultScopeType.DEVICE.value and device_id is not None and cred.device_id == device_id:
                by_scope.setdefault("device", cred)
            elif cred.scope_type == VaultScopeType.GROUP.value and group_id is not None and cred.group_id == group_id:
                by_scope.setdefault("group", cred)
            elif cred.scope_type == VaultScopeType.CLIENT.value and client_id is not None and cred.client_id == client_id:
                by_scope.setdefault("client", cred)
            elif cred.scope_type == VaultScopeType.GLOBAL.value:
                by_scope.setdefault("global", cred)
        for tier in ("device", "group", "client", "global"):
            if tier in by_scope:
                return by_scope[tier]
        return None

    def resolve_ssh_candidates(self, device: Device) -> "tuple[str, List[VaultCredential]]":
        """Embedded SSH Connect credential resolution: Device > Group > Client
        > Global, same precedence as resolve_for_context, but returns EVERY
        ACTIVE SSH-type credential at the first non-empty tier (never mixes
        tiers) so the caller can auto-connect when there's exactly one, or
        offer a selector when there's more than one. Never guesses across
        tiers and never falls back to asking for a password — that is an
        explicit operator choice ("Temporary Session") handled elsewhere."""
        candidates = (
            self.db.query(VaultCredential)
            .filter(
                VaultCredential.status == VaultCredentialStatus.ACTIVE.value,
                VaultCredential.credential_type.in_(SSH_CREDENTIAL_TYPES),
            )
            .order_by(VaultCredential.name)
            .all()
        )
        tiers: Dict[str, List[VaultCredential]] = {"device": [], "group": [], "client": [], "global": []}
        for cred in candidates:
            if cred.scope_type == VaultScopeType.DEVICE.value and cred.device_id == device.id:
                tiers["device"].append(cred)
            elif (
                cred.scope_type == VaultScopeType.GROUP.value
                and device.group_id is not None
                and cred.group_id == device.group_id
            ):
                tiers["group"].append(cred)
            elif (
                cred.scope_type == VaultScopeType.CLIENT.value
                and device.client_id is not None
                and cred.client_id == device.client_id
            ):
                tiers["client"].append(cred)
            elif cred.scope_type == VaultScopeType.GLOBAL.value:
                tiers["global"].append(cred)
        for tier in ("device", "group", "client", "global"):
            if tiers[tier]:
                return tier, tiers[tier]
        return "none", []

    def record_credential_use(
        self, credential: VaultCredential, operator_username: Optional[str], device_id: Optional[int]
    ) -> None:
        """Called after a credential is actually used to establish a live
        connection (not merely resolved) — updates last_used_at and appends a
        'use' usage row, which is what VaultService.enrich() reads to render
        'Used By: Embedded SSH' + 'Last Used' in the Vault UI."""
        credential.last_used_at = utcnow()
        self.db.commit()
        self._record_usage(credential.id, "use", operator_username, device_id=device_id)

    # -- presentation (list/detail enrichment) --------------------------------

    def enrich(self, credential: VaultCredential) -> dict:
        """Computed, non-persisted display fields layered onto the ORM row —
        see VaultCredentialOut for the shape this feeds."""
        now = utcnow()
        references = self.blocking_references(credential)
        assignments = self.list_assignments(credential.id)
        reference_count = len(references)

        expires_at = ensure_utc(credential.expires_at)
        if credential.status == VaultCredentialStatus.DISABLED.value:
            lifecycle_status = "disabled"
        elif expires_at is not None and expires_at <= now:
            lifecycle_status = "expired"
        elif expires_at is not None and expires_at <= now + _EXPIRING_SOON_WINDOW:
            lifecycle_status = "expiring_soon"
        elif credential.last_test_status == "failed":
            lifecycle_status = "validation_failed"
        else:
            lifecycle_status = "active"

        descriptor = get_type(credential.credential_type)
        future_consumers = list(descriptor.future_consumers) if descriptor else []
        # Assignment/scope only describes *where* a credential is meant to
        # apply, not that a live integration actually reads it — see used_by
        # below for real usage.
        if credential.device_id is not None or any(a.device_id for a in assignments):
            consumer_status = "assigned_to_device"
        elif credential.client_id is not None or credential.group_id is not None or any(a.client_id for a in assignments):
            consumer_status = "assigned_to_client"
        else:
            consumer_status = "stored_only"

        # Real, live usage (as opposed to future_consumers, which is a static
        # registry hint): a "use" row is only ever written by
        # record_credential_use(), and Embedded SSH Connect is the only
        # caller of that method today — presence of any such row means this
        # credential has actually authenticated a live connection.
        used_by: List[str] = []
        has_ssh_use = (
            self.db.query(VaultCredentialUsage)
            .filter(VaultCredentialUsage.credential_id == credential.id, VaultCredentialUsage.action == "use")
            .first()
            is not None
        )
        if has_ssh_use:
            used_by.append("Embedded SSH")

        metadata = json.loads(credential.metadata_json) if credential.metadata_json else {}

        return {
            "lifecycle_status": lifecycle_status,
            "is_referenced": reference_count > 0,
            "reference_count": reference_count,
            "references": references,
            "consumer_status": consumer_status,
            "future_consumers": future_consumers,
            "used_by": used_by,
            "metadata": metadata,
        }
