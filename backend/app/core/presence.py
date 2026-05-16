"""
In-memory operator presence store.

Tracks when each operator last made an authenticated API request.
No database writes — purely in-process. Resets on server restart (acceptable
for a presence indicator that only needs to reflect the current session window).
"""
import time
from datetime import datetime, timezone
from typing import Dict, Optional

_timestamps: Dict[int, float] = {}
DEBOUNCE_SECONDS = 30


def touch(operator_id: int) -> None:
    now = time.monotonic()
    if now - _timestamps.get(operator_id, 0.0) >= DEBOUNCE_SECONDS:
        _timestamps[operator_id] = now


def get_last_active(operator_id: int) -> Optional[datetime]:
    ts = _timestamps.get(operator_id)
    if ts is None:
        return None
    wall = datetime.now(tz=timezone.utc).timestamp() - (time.monotonic() - ts)
    return datetime.fromtimestamp(wall, tz=timezone.utc)


def is_online(operator_id: int, ttl_seconds: int = 90) -> bool:
    ts = _timestamps.get(operator_id)
    return ts is not None and (time.monotonic() - ts) < ttl_seconds
