"""
Agent configuration policy service.

Stores the platform-desired heartbeat_interval_seconds in a JSON file.
Path is configurable via the AGENT_POLICY_FILE environment variable;
default is /app/data/agent_policy.json (backed by the backend_data Docker volume).

Falls back gracefully to in-memory storage if the path is not writable — the
value then resets to the default on container restart, which is safe because
the default (180 s) is the intended target.

Thread-safe: all reads and writes are serialised through a single RLock.
"""

import json
import logging
import os
import threading
from typing import Optional

log = logging.getLogger("techi.agent_config")

_POLICY_FILE: str = os.environ.get("AGENT_POLICY_FILE", "/app/data/agent_policy.json")

HEARTBEAT_INTERVAL_DEFAULT: int = 180
HEARTBEAT_INTERVAL_MIN: int = 60
HEARTBEAT_INTERVAL_MAX: int = 600

# Fixed constants — kept in sync with device_repository.py and device.py
ONLINE_THRESHOLD_MINUTES: int = 6
STALE_THRESHOLD_MINUTES: int = 25

_lock = threading.RLock()
_policy: Optional[dict] = None


def _ensure_dir(path: str) -> None:
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)


def _load() -> dict:
    global _policy
    if _policy is not None:
        return _policy
    try:
        _ensure_dir(_POLICY_FILE)
        with open(_POLICY_FILE, "r", encoding="utf-8") as fh:
            _policy = json.load(fh)
    except FileNotFoundError:
        _policy = {"heartbeat_interval_seconds": HEARTBEAT_INTERVAL_DEFAULT}
    except Exception as exc:
        log.warning("Cannot read agent policy %s: %s — using defaults", _POLICY_FILE, exc)
        _policy = {"heartbeat_interval_seconds": HEARTBEAT_INTERVAL_DEFAULT}
    return _policy


def _persist(data: dict) -> None:
    try:
        _ensure_dir(_POLICY_FILE)
        with open(_POLICY_FILE, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
    except Exception as exc:
        log.warning("Cannot save agent policy %s: %s — change is in-memory only", _POLICY_FILE, exc)


def get_policy() -> dict:
    with _lock:
        data = _load()
        return {
            "heartbeat_interval_seconds": data.get(
                "heartbeat_interval_seconds", HEARTBEAT_INTERVAL_DEFAULT
            ),
            "online_threshold_minutes": ONLINE_THRESHOLD_MINUTES,
            "stale_threshold_minutes": STALE_THRESHOLD_MINUTES,
        }


def set_heartbeat_interval(seconds: int) -> dict:
    if not (HEARTBEAT_INTERVAL_MIN <= seconds <= HEARTBEAT_INTERVAL_MAX):
        raise ValueError(
            f"heartbeat_interval_seconds must be between "
            f"{HEARTBEAT_INTERVAL_MIN} and {HEARTBEAT_INTERVAL_MAX}, got {seconds}"
        )
    with _lock:
        data = _load()
        data["heartbeat_interval_seconds"] = seconds
        _persist(data)
    return get_policy()


def reset_for_testing(tmp_path: Optional[str] = None) -> None:
    """Reset in-memory state. For tests only — not called in production."""
    global _policy, _POLICY_FILE
    _policy = None
    if tmp_path is not None:
        _POLICY_FILE = tmp_path
