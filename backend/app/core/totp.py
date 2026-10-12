"""Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s).

The parameters every authenticator app (Microsoft, Google, 1Password, Authy)
supports by default. Standard library only.
"""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from typing import Optional
from urllib.parse import quote, urlencode

STEP_SECONDS = 30
DIGITS = 6


def generate_secret() -> str:
    """160 random bits, base32 without padding — what authenticator apps expect."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _key(secret: str) -> bytes:
    padded = secret.upper() + "=" * (-len(secret) % 8)
    return base64.b32decode(padded)


def code_at(secret: str, step: int) -> str:
    digest = hmac.new(_key(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def current_step(now: Optional[float] = None) -> int:
    return int((time.time() if now is None else now) // STEP_SECONDS)


def verify(secret: str, code: str, *, last_step: Optional[int] = None, now: Optional[float] = None, window: int = 1) -> Optional[int]:
    """Return the matched time step, or None.

    Accepts the current step ±`window` (clock drift between phone and server).
    A step at or before `last_step` is refused, so a code that was already
    used — or an older one — cannot be replayed.
    """
    normalized = "".join(ch for ch in code if ch.isdigit())
    if len(normalized) != DIGITS:
        return None
    step = current_step(now)
    for candidate in range(step - window, step + window + 1):
        if last_step is not None and candidate <= last_step:
            continue
        if hmac.compare_digest(code_at(secret, candidate), normalized):
            return candidate
    return None


def provisioning_uri(secret: str, account: str, issuer: str) -> str:
    """otpauth:// URI an authenticator app scans as a QR code."""
    label = quote(f"{issuer}:{account}")
    params = urlencode({"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": DIGITS, "period": STEP_SECONDS})
    return f"otpauth://totp/{label}?{params}"


def generate_recovery_codes(count: int = 10) -> list:
    """One-time codes for a lost phone: 10 hex chars as xxxxx-xxxxx."""
    codes = []
    for _ in range(count):
        raw = secrets.token_hex(5)
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def hash_recovery_code(code: str) -> str:
    normalized = code.strip().lower().replace("-", "").replace(" ", "")
    return hashlib.sha256(normalized.encode("ascii", "ignore")).hexdigest()
