import hashlib
import hmac
import re
import secrets
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional

from app.core.config import settings
from app.core.time import utcnow
from app.core.vault_cipher import VaultCipherError, decrypt_secret, encrypt_secret
from app.models.device import Device


def compute_callback_token(action_id: int) -> str:
    """Return an HMAC-SHA256 token tied to this action_id.
    Stateless — no DB storage required."""
    msg = f"action-callback:{action_id}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()


def verify_callback_token(action_id: int, provided: str) -> bool:
    """Constant-time comparison of the expected vs. provided callback token."""
    if not provided:
        return False
    expected = compute_callback_token(action_id)
    return hmac.compare_digest(expected, provided)


class _SlidingWindowRateLimiter:
    """Thread-safe in-memory sliding-window rate limiter."""

    def __init__(self, limit: int, window_seconds: int):
        self._limit = limit
        self._window = window_seconds
        self._lock = threading.Lock()
        self._hits: Dict[str, List[float]] = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self._window
        with self._lock:
            timestamps = self._hits[key]
            # Drop expired hits
            self._hits[key] = [t for t in timestamps if t > cutoff]
            if len(self._hits[key]) >= self._limit:
                return False
            self._hits[key].append(now)
            return True


login_limiter = _SlidingWindowRateLimiter(limit=10, window_seconds=60)
enroll_limiter = _SlidingWindowRateLimiter(limit=100, window_seconds=60)
verify_token_limiter = _SlidingWindowRateLimiter(limit=10, window_seconds=60)
# The source-IP guard is deliberately generous because many endpoints can share
# one NAT/proxy address; the per-Agent guard is the primary abuse boundary.
heartbeat_auth_limiter = _SlidingWindowRateLimiter(limit=6000, window_seconds=60)
heartbeat_identity_limiter = _SlidingWindowRateLimiter(limit=30, window_seconds=60)
# Native Remote Support launch capabilities are short-lived, but issuance and
# redemption still get independent abuse boundaries.
remote_connect_create_limiter = _SlidingWindowRateLimiter(limit=20, window_seconds=60)
remote_connect_redeem_limiter = _SlidingWindowRateLimiter(limit=60, window_seconds=60)
remote_connect_report_limiter = _SlidingWindowRateLimiter(limit=120, window_seconds=60)


HEARTBEAT_SIGNATURE_VERSION = "v1"
HEARTBEAT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_SIGNATURE_RE = re.compile(r"^[0-9a-f]{64}$")


class AgentAuthError(Exception):
    def __init__(self, reason: str, *, status_code: int = 401):
        super().__init__(reason)
        self.reason = reason
        self.status_code = status_code


@dataclass(frozen=True)
class HeartbeatTrust:
    mode: str
    authenticated: bool
    legacy_restricted: bool
    reason: str
    device: Optional[Device] = None


_HEARTBEAT_AUTH_HEADERS = (
    "x-techi-agent-id",
    "x-techi-agent-timestamp",
    "x-techi-agent-nonce",
    "x-techi-agent-signature",
)


def heartbeat_auth_material_missing(headers) -> bool:
    return not any((headers.get(name) or "").strip() for name in _HEARTBEAT_AUTH_HEADERS)


def issue_agent_credential(device: Device) -> str:
    """Rotate and return a device-bound heartbeat credential.

    Enrollment is the only caller. The plaintext is returned once and only the
    envelope-encrypted value plus a diagnostic hash are stored server-side.
    """
    credential = secrets.token_urlsafe(32)
    ciphertext, wrapped_dek = encrypt_secret(credential)
    device.agent_auth_secret_ciphertext = ciphertext
    device.agent_auth_secret_wrapped_dek = wrapped_dek
    device.agent_auth_key_hash = hashlib.sha256(credential.encode("utf-8")).hexdigest()
    device.agent_auth_issued_at = utcnow()
    device.agent_auth_revoked_at = None
    device.agent_auth_last_timestamp_ms = None
    device.agent_auth_last_nonce = None
    if device.remote_support_apply_status in (None, "unsupported_legacy"):
        device.remote_support_apply_status = "unknown"
    return credential


def heartbeat_signature(credential: str, agent_id: str, timestamp_ms: int, nonce: str, body: bytes) -> str:
    body_hash = hashlib.sha256(body).hexdigest()
    message = f"{HEARTBEAT_SIGNATURE_VERSION}\n{agent_id}\n{timestamp_ms}\n{nonce}\n{body_hash}".encode("utf-8")
    return hmac.new(credential.encode("utf-8"), message, hashlib.sha256).hexdigest()


def verify_heartbeat_request(db, *, body: bytes, headers, payload) -> Device:
    agent_id = (headers.get("x-techi-agent-id") or "").strip()
    timestamp_text = (headers.get("x-techi-agent-timestamp") or "").strip()
    nonce = (headers.get("x-techi-agent-nonce") or "").strip()
    signature = (headers.get("x-techi-agent-signature") or "").strip().lower()

    if not all((agent_id, timestamp_text, nonce, signature)):
        raise AgentAuthError("agent_reenrollment_required", status_code=428)
    try:
        timestamp_ms = int(timestamp_text)
    except ValueError as exc:
        raise AgentAuthError("invalid_timestamp") from exc
    if not _NONCE_RE.fullmatch(nonce) or not _SIGNATURE_RE.fullmatch(signature):
        raise AgentAuthError("malformed_signature")
    now_ms = int(time.time() * 1000)
    if abs(now_ms - timestamp_ms) > HEARTBEAT_MAX_CLOCK_SKEW_MS:
        raise AgentAuthError("timestamp_outside_window")

    device = db.query(Device).filter(Device.agent_id == agent_id).first()
    if device is None:
        raise AgentAuthError("unknown_agent")
    if device.agent_auth_revoked_at is not None:
        raise AgentAuthError("credential_revoked")
    if not device.agent_auth_secret_ciphertext or not device.agent_auth_secret_wrapped_dek:
        raise AgentAuthError("agent_reenrollment_required", status_code=428)
    if payload.agent_id != device.agent_id or payload.device_id != device.id:
        raise AgentAuthError("cross_device_identity")
    if payload.client_id is not None and payload.client_id != device.client_id:
        raise AgentAuthError("cross_tenant_identity")
    if payload.group_id is not None and payload.group_id != device.group_id:
        raise AgentAuthError("cross_tenant_identity")
    last_timestamp = device.agent_auth_last_timestamp_ms or 0
    if timestamp_ms <= last_timestamp:
        raise AgentAuthError("replayed_request")

    try:
        credential = decrypt_secret(
            device.agent_auth_secret_ciphertext,
            device.agent_auth_secret_wrapped_dek,
        )
    except VaultCipherError as exc:
        raise AgentAuthError("credential_unavailable") from exc
    expected = heartbeat_signature(credential, agent_id, timestamp_ms, nonce, body)
    if not hmac.compare_digest(expected, signature):
        raise AgentAuthError("invalid_signature")

    device.agent_auth_last_timestamp_ms = timestamp_ms
    device.agent_auth_last_nonce = nonce
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def resolve_heartbeat_trust(db, *, body: bytes, headers, payload) -> HeartbeatTrust:
    mode = settings.AGENT_HEARTBEAT_AUTH_MODE
    if mode not in {"disabled", "observe", "enforce"}:
        raise AgentAuthError("invalid_heartbeat_auth_mode", status_code=500)

    try:
        device = verify_heartbeat_request(db, body=body, headers=headers, payload=payload)
        return HeartbeatTrust(
            mode=mode,
            authenticated=True,
            legacy_restricted=False,
            reason="authenticated",
            device=device,
        )
    except AgentAuthError:
        if mode == "enforce" or not heartbeat_auth_material_missing(headers):
            raise
        return HeartbeatTrust(
            mode=mode,
            authenticated=False,
            legacy_restricted=True,
            reason=f"{mode}_legacy_missing_auth",
            device=None,
        )
