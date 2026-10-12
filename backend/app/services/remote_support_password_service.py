"""Per-device TECHI Remote Support (RustDesk) password.

Replaces the fleet-wide shared password. Each device gets a unique,
server-generated permanent password stored encrypted at rest; an operator can
override it with a custom value from the UI. The value is pushed to the agent
via the set_remote_password action and consumed by /connect-url.
"""
import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.secret_cipher import decrypt_secret, encrypt_secret
from app.core.time import ensure_utc, utcnow
from app.models.device import Device

logger = logging.getLogger(__name__)

# Unambiguous alphabet (no 0/O/1/l/I) so operators can read/type it reliably.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
_LENGTH = 16


def generate_password() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))


def agent_applies_per_device_password(device: Device) -> bool:
    """Only >= 2.1.5 agents apply the server's per-device password to RustDesk;
    older ones still hold the legacy shared password."""
    parts = []
    for piece in (getattr(device, "agent_version", None) or "").strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            return False
        parts.append(int(digits))
    return tuple(parts) >= (2, 1, 5)


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

    def for_connect(self, device: Device) -> str:
        """The password RustDesk on the device answers to right now.

        A changed password reaches the agent with its next heartbeat, which
        applies it at once; until the device has checked in after the change,
        RustDesk still holds the previous one."""
        current = self.get_or_create(device)
        previous = decrypt_secret(device.remote_support_password_previous_ciphertext)
        if not previous:
            return current
        if self._delivered(device):
            device.remote_support_password_previous_ciphertext = None
            self.db.add(device)
            self.db.commit()
            return current
        return previous

    @staticmethod
    def _delivered(device: Device) -> bool:
        changed = ensure_utc(device.remote_support_password_updated_at)
        seen = ensure_utc(device.last_seen)
        return changed is None or (seen is not None and seen > changed)

    def rotate(self, device: Device) -> str:
        """A new generated password, replacing a custom one too."""
        return self._store(device, generate_password(), source="generated")

    def rotate_due(self, *, now: Optional[datetime] = None) -> int:
        """Rotates generated passwords older than the rotation period on
        devices whose agent applies them, skipping live sessions (applying a
        password restarts Remote Support). Returns how many were rotated."""
        days = settings.REMOTE_SUPPORT_PASSWORD_ROTATION_DAYS
        if days <= 0:
            return 0
        cutoff = (ensure_utc(now or utcnow()) - timedelta(days=days)).replace(tzinfo=None)
        due = (
            self.db.query(Device)
            .filter(
                Device.is_archived.is_(False),
                Device.remote_support_password_ciphertext.isnot(None),
                Device.remote_support_password_source == "generated",
                Device.remote_support_password_updated_at <= cutoff,
                Device.rustdesk_session_active.is_(False),
            )
            .all()
        )
        rotated = 0
        for device in due:
            if agent_applies_per_device_password(device):
                self.rotate(device)
                rotated += 1
        return rotated

    def rotate_all(self) -> int:
        """Every device whose agent applies per-device passwords gets a new
        one now, e.g. when someone with access leaves. Returns the count."""
        devices = self.db.query(Device).filter(Device.is_archived.is_(False)).all()
        rotated = 0
        for device in devices:
            if agent_applies_per_device_password(device):
                self.rotate(device)
                rotated += 1
        return rotated

    def set_custom(self, device: Device, password: str) -> str:
        password = (password or "").strip()
        if not (8 <= len(password) <= 128):
            raise ValueError("Password must be between 8 and 128 characters")
        return self._store(device, password, source="custom")

    def regenerate(self, device: Device) -> str:
        return self._store(device, generate_password(), source="generated")

    def _store(self, device: Device, password: str, *, source: str) -> str:
        # Keep the password RustDesk still holds until the agent has the new
        # one (for_connect); a second change before that keeps the oldest.
        if device.remote_support_password_ciphertext and (
            not device.remote_support_password_previous_ciphertext or self._delivered(device)
        ):
            device.remote_support_password_previous_ciphertext = device.remote_support_password_ciphertext
        device.remote_support_password_ciphertext = encrypt_secret(password)
        device.remote_support_password_updated_at = utcnow()
        device.remote_support_password_source = source
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)
        logger.info("[rs_password] %s password for device #%d", source, device.id)
        return password
