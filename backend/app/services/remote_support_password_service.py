"""Acknowledged per-device Remote Support credential lifecycle.

The backend keeps the last confirmed active credential while a newly requested
generation is pending. Only an authenticated matching Agent can acknowledge a
generation. Passwords and per-operation verification keys use the repository's
AES-GCM Vault envelope encryption; legacy v1 ciphertext migrates on read.
"""

import base64
import hashlib
import hmac
import logging
import re
import secrets
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.core.secret_cipher import decrypt_secret as decrypt_legacy_secret
from app.core.time import utcnow
from app.core.vault_cipher import decrypt_secret as vault_decrypt_secret
from app.core.vault_cipher import encrypt_secret as vault_encrypt_secret
from app.models.device import Device

logger = logging.getLogger(__name__)

_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
_LENGTH = 16
_SANITIZE_REASON = re.compile(r"[^A-Za-z0-9 ._:/()\-]")


def generate_password() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))


def credential_fingerprint(
    verification_key: str,
    *,
    device_id: int,
    generation: int,
    password: str,
) -> str:
    key = base64.urlsafe_b64decode(verification_key + "=" * (-len(verification_key) % 4))
    message = f"v1\n{device_id}\n{generation}\n{password}".encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class CredentialDelivery:
    generation: int
    password: str
    source: str
    verification_key: str


class RemoteSupportPasswordService:
    def __init__(self, db: Session):
        self.db = db

    def get_active_plaintext(self, device: Device) -> Optional[str]:
        ciphertext = device.remote_support_password_ciphertext
        if not ciphertext:
            return None
        if device.remote_support_password_wrapped_dek:
            return vault_decrypt_secret(ciphertext, device.remote_support_password_wrapped_dek)

        # Backward-compatible migration of the old v1 XOR/HMAC ciphertext. The
        # old bytes are replaced only after successful decryption and encryption.
        plaintext = decrypt_legacy_secret(ciphertext)
        if not plaintext:
            return None
        sealed, wrapped = vault_encrypt_secret(plaintext)
        device.remote_support_password_ciphertext = sealed
        device.remote_support_password_wrapped_dek = wrapped
        if not device.remote_support_active_generation:
            device.remote_support_active_generation = 1
        if not device.remote_support_applied_generation:
            device.remote_support_applied_generation = device.remote_support_active_generation
        if device.remote_support_apply_status in (None, "unknown", "unsupported_legacy"):
            device.remote_support_apply_status = "unsupported_legacy"
        self._save(device)
        logger.info("[rs_credential] migrated active credential encryption for device #%d", device.id)
        return plaintext

    # Compatibility name for callers that explicitly reveal the active value.
    def get_plaintext(self, device: Device) -> Optional[str]:
        return self.get_active_plaintext(device)

    def ensure_desired(self, device: Device) -> CredentialDelivery:
        existing = self.pending_delivery(device)
        if existing is not None:
            return existing
        return self._create_desired(device, generate_password(), source="generated")

    def set_custom(self, device: Device, password: str) -> str:
        password = (password or "").strip()
        if not (8 <= len(password) <= 128):
            raise ValueError("Password must be between 8 and 128 characters")
        return self._create_desired(device, password, source="custom").password

    def regenerate(self, device: Device) -> str:
        return self._create_desired(device, generate_password(), source="generated").password

    def pending_delivery(self, device: Device) -> Optional[CredentialDelivery]:
        if device.remote_support_apply_status != "pending":
            return None
        required = (
            device.remote_support_desired_password_ciphertext,
            device.remote_support_desired_password_wrapped_dek,
            device.remote_support_verification_key_ciphertext,
            device.remote_support_verification_key_wrapped_dek,
        )
        if not all(required) or not device.remote_support_desired_generation:
            return None
        password = vault_decrypt_secret(required[0], required[1])
        verification_key = vault_decrypt_secret(required[2], required[3])
        return CredentialDelivery(
            generation=device.remote_support_desired_generation,
            password=password,
            source=device.remote_support_desired_source or "generated",
            verification_key=verification_key,
        )

    def process_ack(self, device: Device, ack) -> bool:
        if ack is None:
            return False
        generation = int(getattr(ack, "generation", 0) or 0)
        if generation != device.remote_support_desired_generation:
            return False
        status = (getattr(ack, "status", "") or "").strip().lower()
        if status == "failed":
            device.remote_support_apply_status = "failed"
            device.remote_support_failure_reason = self._sanitize_reason(getattr(ack, "error", None))
            self._save(device)
            return True
        if status != "applied":
            return False
        fingerprint = (getattr(ack, "fingerprint", "") or "").strip().lower()
        expected = (device.remote_support_expected_fingerprint or "").lower()
        if not expected or not hmac.compare_digest(fingerprint, expected):
            device.remote_support_apply_status = "failed"
            device.remote_support_failure_reason = "credential acknowledgement fingerprint mismatch"
            self._save(device)
            return True

        # Promote only after the authenticated matching ACK. Until here the
        # previous active ciphertext remains untouched and usable.
        device.remote_support_password_ciphertext = device.remote_support_desired_password_ciphertext
        device.remote_support_password_wrapped_dek = device.remote_support_desired_password_wrapped_dek
        device.remote_support_password_source = device.remote_support_desired_source
        device.remote_support_password_updated_at = utcnow()
        device.remote_support_active_generation = generation
        device.remote_support_applied_generation = generation
        device.remote_support_applied_at = utcnow()
        device.remote_support_applied_fingerprint = fingerprint
        device.remote_support_apply_status = "applied"
        device.remote_support_failure_reason = None
        device.remote_support_verification_key_ciphertext = None
        device.remote_support_verification_key_wrapped_dek = None
        self._save(device)
        logger.info("[rs_credential] applied generation=%d device=%d", generation, device.id)
        return True

    def _create_desired(self, device: Device, password: str, *, source: str) -> CredentialDelivery:
        generation = max(
            device.remote_support_desired_generation or 0,
            device.remote_support_active_generation or 0,
            device.remote_support_applied_generation or 0,
        ) + 1
        verification_key = secrets.token_urlsafe(32)
        password_ciphertext, password_wrapped = vault_encrypt_secret(password)
        key_ciphertext, key_wrapped = vault_encrypt_secret(verification_key)
        device.remote_support_desired_generation = generation
        device.remote_support_desired_password_ciphertext = password_ciphertext
        device.remote_support_desired_password_wrapped_dek = password_wrapped
        device.remote_support_desired_source = source
        device.remote_support_desired_created_at = utcnow()
        device.remote_support_verification_key_ciphertext = key_ciphertext
        device.remote_support_verification_key_wrapped_dek = key_wrapped
        device.remote_support_expected_fingerprint = credential_fingerprint(
            verification_key,
            device_id=device.id,
            generation=generation,
            password=password,
        )
        device.remote_support_apply_status = "pending"
        device.remote_support_failure_reason = None
        self._save(device)
        logger.info("[rs_credential] desired source=%s generation=%d device=%d", source, generation, device.id)
        return CredentialDelivery(generation, password, source, verification_key)

    def _save(self, device: Device) -> None:
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)

    @staticmethod
    def _sanitize_reason(value: Optional[str]) -> str:
        cleaned = _SANITIZE_REASON.sub("?", (value or "credential application failed").strip())
        return cleaned[:255] or "credential application failed"
