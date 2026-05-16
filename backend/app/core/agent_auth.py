import hashlib
import hmac
import threading
import time
from collections import defaultdict
from typing import Dict, List

from app.core.config import settings


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
enroll_limiter = _SlidingWindowRateLimiter(limit=5, window_seconds=60)
verify_token_limiter = _SlidingWindowRateLimiter(limit=10, window_seconds=60)
