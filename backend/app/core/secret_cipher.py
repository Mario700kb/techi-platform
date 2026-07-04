"""Reversible at-rest encryption for small secrets (RS passwords, ...).

Same authenticated XOR-keystream scheme already used for enrollment token
ciphertext, keyed off settings.SECRET_KEY. Not a substitute for a KMS, but it
keeps secrets from sitting in the database as plaintext and detects tampering
via HMAC. Ciphertext is self-describing ("v1:" prefix) so the scheme can be
rotated later.
"""
import base64
import hashlib
import hmac
import logging
import secrets
from typing import Optional

from app.core.config import settings

logger = logging.getLogger(__name__)


def _key() -> bytes:
    return hashlib.sha256(settings.SECRET_KEY.encode("utf-8")).digest()


def _keystream(nonce: bytes, length: int) -> bytes:
    key = _key()
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def encrypt_secret(plaintext: str) -> str:
    raw = plaintext.encode("utf-8")
    nonce = secrets.token_bytes(16)
    stream = _keystream(nonce, len(raw))
    ciphertext = bytes(a ^ b for a, b in zip(raw, stream))
    mac = hmac.new(_key(), nonce + ciphertext, hashlib.sha256).digest()
    return "v1:" + base64.urlsafe_b64encode(nonce + mac + ciphertext).decode("ascii")


def decrypt_secret(ciphertext: Optional[str]) -> Optional[str]:
    if not ciphertext or not ciphertext.startswith("v1:"):
        return None
    try:
        payload = base64.urlsafe_b64decode(ciphertext[3:].encode("ascii"))
        nonce, mac, body = payload[:16], payload[16:48], payload[48:]
        expected = hmac.new(_key(), nonce + body, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            return None
        stream = _keystream(nonce, len(body))
        return bytes(a ^ b for a, b in zip(body, stream)).decode("utf-8")
    except Exception:
        logger.exception("Failed to decrypt secret ciphertext")
        return None
