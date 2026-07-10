"""Enterprise Credential Vault service (Phase 4, audit §19).

Rules enforced here:
  - secrets are stored only as AES-256-GCM envelope ciphertext (vault_cipher);
  - plaintext exists in memory only during use/reveal, never in logs/responses
    except the explicit, audited /reveal path;
  - every access writes an append-only vault_credential_usage row;
  - scope integrity: scope_type dictates exactly which target id must be set.

The Remote Support password system (secret_cipher) is untouched by design.
"""

import hashlib
import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.core.vault_cipher import decrypt_secret, encrypt_secret
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.vault_credential import (
    VaultCredential,
    VaultCredentialUsage,
    VaultScopeType,
)
from app.schemas.vault import VaultCredentialCreate, VaultCredentialUpdate

logger = logging.getLogger(__name__)

_SCOPE_TARGET_FIELD = {
    VaultScopeType.GLOBAL.value: None,
    VaultScopeType.CLIENT.value: "client_id",
    VaultScopeType.GROUP.value: "group_id",
    VaultScopeType.DEVICE.value: "device_id",
}


class VaultScopeError(ValueError):
    pass


class VaultReferencedError(ValueError):
    """Raised when a credential is scoped to a target that still exists —
    deleting it would silently remove access the operator may not realize is
    still in use. Carries the human-readable references for the 409 body."""

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

    # -- CRUD --------------------------------------------------------------

    def create(self, data: VaultCredentialCreate, created_by: Optional[str]) -> VaultCredential:
        self._validate_scope(data.scope_type.value, data.client_id, data.group_id, data.device_id)
        ciphertext, wrapped = encrypt_secret(data.secret)
        credential = VaultCredential(
            name=data.name,
            credential_type=data.credential_type.value,
            scope_type=data.scope_type.value,
            client_id=data.client_id,
            group_id=data.group_id,
            device_id=data.device_id,
            username=data.username,
            ciphertext=ciphertext,
            dek_wrapped=wrapped,
            notes=data.notes,
            created_by=created_by,
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
        if data.notes is not None:
            credential.notes = data.notes
        if data.secret is not None:
            credential.ciphertext, credential.dek_wrapped = encrypt_secret(data.secret)
            credential.rotated_at = utcnow()
            rotated = True
        self.db.commit()
        self.db.refresh(credential)
        self._record_usage(credential.id, "rotate" if rotated else "update", operator_username)
        return credential

    def blocking_references(self, credential: VaultCredential) -> List[str]:
        """Human-readable references that still point at this credential's
        scope target. An orphaned scope (target already deleted) never blocks
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
        self.db.delete(credential)
        self.db.commit()
        self._record_usage(credential_id, "delete", operator_username)

    # -- secret access -----------------------------------------------------

    def reveal(
        self, credential: VaultCredential, operator_username: Optional[str], reason: str
    ) -> str:
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
        return plaintext

    def usage(self, credential_id: int, limit: int = 100) -> List[VaultCredentialUsage]:
        return (
            self.db.query(VaultCredentialUsage)
            .filter(VaultCredentialUsage.credential_id == credential_id)
            .order_by(VaultCredentialUsage.created_at.desc())
            .limit(limit)
            .all()
        )
