"""Envelope encryption for the Enterprise Credential Vault (Phase 4).

AES-256-GCM, per the DESIGN-LOCKED audit §19:
    master key (file, outside repo/DB) → per-credential DEK → secret payload.

Deliberately SEPARATE from app.core.secret_cipher (the keystream scheme used
by the Remote Support password flow) — that system is frozen and untouched.

Storage formats (self-describing for future rotation):
    secret ciphertext : "vgcm1:" + b64(nonce12 + AESGCM(dek).encrypt(payload))
    wrapped DEK       : "vgcm1:" + b64(nonce12 + AESGCM(master).encrypt(dek))

Master-key rotation = re-wrap every stored DEK with the new master key; the
payload ciphertext never needs re-encryption (audit §19 "Key Rotation").
"""

import base64
import logging
import os
import secrets
import threading
from typing import Optional, Tuple

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

logger = logging.getLogger(__name__)

_PREFIX = "vgcm1:"
_NONCE_LEN = 12
_KEY_LEN = 32

_master_key_cache: Optional[bytes] = None
_master_key_lock = threading.Lock()


class VaultCipherError(Exception):
    """Raised when vault material cannot be decrypted (wrong key / tampering)."""


def _master_key_path() -> str:
    return settings.VAULT_MASTER_KEY_FILE


def _load_or_create_master_key() -> bytes:
    global _master_key_cache
    if _master_key_cache is not None:
        return _master_key_cache
    with _master_key_lock:
        if _master_key_cache is not None:
            return _master_key_cache
        path = _master_key_path()
        if os.path.exists(path):
            with open(path, "rb") as fh:
                key = base64.b64decode(fh.read().strip())
            if len(key) != _KEY_LEN:
                raise VaultCipherError(f"Vault master key at {path} has invalid length")
        else:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            key = secrets.token_bytes(_KEY_LEN)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as fh:
                fh.write(base64.b64encode(key))
            os.chmod(path, 0o400)
            logger.warning(
                "Vault master key GENERATED at %s — ensure it is included in the "
                "config backup (losing it makes every vault secret unrecoverable)",
                path,
            )
        _master_key_cache = key
        return key


def _seal(key: bytes, payload: bytes) -> str:
    nonce = secrets.token_bytes(_NONCE_LEN)
    sealed = AESGCM(key).encrypt(nonce, payload, None)
    return _PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii")


def _open(key: bytes, token: str, what: str) -> bytes:
    if not token.startswith(_PREFIX):
        raise VaultCipherError(f"Unknown {what} format")
    raw = base64.urlsafe_b64decode(token[len(_PREFIX):].encode("ascii"))
    nonce, sealed = raw[:_NONCE_LEN], raw[_NONCE_LEN:]
    try:
        return AESGCM(key).decrypt(nonce, sealed, None)
    except InvalidTag as exc:
        raise VaultCipherError(f"Vault {what} failed authentication (tampered or wrong key)") from exc


def encrypt_secret(plaintext: str) -> Tuple[str, str]:
    """Encrypt one secret. Returns (ciphertext, wrapped_dek) for storage."""
    dek = secrets.token_bytes(_KEY_LEN)
    ciphertext = _seal(dek, plaintext.encode("utf-8"))
    wrapped = _seal(_load_or_create_master_key(), dek)
    return ciphertext, wrapped


def decrypt_secret(ciphertext: str, wrapped_dek: str) -> str:
    dek = _open(_load_or_create_master_key(), wrapped_dek, "DEK")
    return _open(dek, ciphertext, "secret").decode("utf-8")


def rewrap_dek(wrapped_dek: str, new_master_key: bytes) -> str:
    """Rotation primitive: re-wrap a DEK under a new master key (payload untouched)."""
    dek = _open(_load_or_create_master_key(), wrapped_dek, "DEK")
    nonce = secrets.token_bytes(_NONCE_LEN)
    sealed = AESGCM(new_master_key).encrypt(nonce, dek, None)
    return _PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii")


def reset_master_key_cache_for_tests() -> None:
    global _master_key_cache
    _master_key_cache = None
