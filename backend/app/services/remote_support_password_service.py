"""Per-device TECHI Remote Support (RustDesk) password.

Replaces the fleet-wide shared password. Each device gets a unique,
server-generated permanent password stored encrypted at rest; an operator can
override it with a custom value from the UI. The value is pushed to the agent
via the set_remote_password action and consumed by /connect-url.
"""
import logging
import secrets
import string
from typing import Optional

from sqlalchemy.orm import Session

from app.core.secret_cipher import decrypt_secret, encrypt_secret
from app.core.time import utcnow
from app.models.device import Device

logger = logging.getLogger(__name__)

# Unambiguous alphabet (no 0/O/1/l/I) so operators can read/type it reliably.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
_LENGTH = 16


def generate_password() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))


class RemoteSupportPasswordService:
    def __init__(self, db: Session):
        self.db = db

    def get_plaintext(self, device: Device) -> Optional[str]:
        return decrypt_secret(device.remote_support_password_ciphertext)

    def get_or_create(self, device: Device) -> str:
        """Return the device's RS password, generating and persisting a unique
        one on first use. Never returns the old fleet-wide default."""
        existing = self.get_plaintext(device)
        if existing:
            return existing
        return self._store(device, generate_password(), source="generated")

    def set_custom(self, device: Device, password: str) -> str:
        password = (password or "").strip()
        if not (8 <= len(password) <= 128):
            raise ValueError("Password must be between 8 and 128 characters")
        return self._store(device, password, source="custom")

    def regenerate(self, device: Device) -> str:
        return self._store(device, generate_password(), source="generated")

    def _store(self, device: Device, password: str, *, source: str) -> str:
        device.remote_support_password_ciphertext = encrypt_secret(password)
        device.remote_support_password_updated_at = utcnow()
        device.remote_support_password_source = source
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)
        logger.info("[rs_password] %s password for device #%d", source, device.id)
        return password
