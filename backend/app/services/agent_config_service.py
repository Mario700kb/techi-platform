"""
Agent configuration policy service.

Stores platform-desired heartbeat and inventory intervals in a JSON file.
Path is configurable via the AGENT_POLICY_FILE environment variable;
default is /app/data/agent_policy.json (backed by the backend_data Docker volume).

Falls back gracefully to in-memory storage if the path is not writable — the
value then resets to the built-in platform defaults on container restart.

Thread-safe: all reads and writes are serialised through a single RLock.
"""

import json
import logging
import os
import threading
from typing import Dict, Mapping, Optional

log = logging.getLogger("techi.agent_config")

_POLICY_FILE: str = os.environ.get("AGENT_POLICY_FILE", "/app/data/agent_policy.json")

HEARTBEAT_INTERVAL_DEFAULT: int = 300
HEARTBEAT_INTERVAL_MIN: int = 60
HEARTBEAT_INTERVAL_MAX: int = 600
INVENTORY_INTERVAL_DEFAULT: int = 1800
INVENTORY_INTERVAL_MIN: int = 300
INVENTORY_INTERVAL_MAX: int = 86400
PLATFORM_HEARTBEAT_DEFAULTS: Dict[str, int] = {
    "windows": 300,
    "linux": 250,
    "macos": 300,
    "mikrotik": 250,
    "synology": 300,
    "qnap": 300,
    "truenas": 300,
    "vmware": 300,
    "proxmox": 300,
}
PLATFORM_INVENTORY_DEFAULTS: Dict[str, int] = {
    platform: INVENTORY_INTERVAL_DEFAULT for platform in PLATFORM_HEARTBEAT_DEFAULTS
}
REMOTE_SUPPORT_MANAGED_PASSWORD_DEFAULT: bool = os.environ.get(
    "RUSTDESK_DEEP_LINK_PASSWORD_ENABLED", "true"
).strip().lower() not in {"0", "false", "no", "off"}

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
        _policy = {
            "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_DEFAULT,
            "remote_support_managed_password_enabled": REMOTE_SUPPORT_MANAGED_PASSWORD_DEFAULT,
        }
    except Exception as exc:
        log.warning("Cannot read agent policy %s: %s — using defaults", _POLICY_FILE, exc)
        _policy = {
            "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_DEFAULT,
            "remote_support_managed_password_enabled": REMOTE_SUPPORT_MANAGED_PASSWORD_DEFAULT,
        }
    return _policy


def _normalized_platform_intervals(
    raw: Optional[Mapping[str, object]],
    defaults: Mapping[str, int],
    *,
    low: int,
    high: int,
) -> Dict[str, int]:
    out: Dict[str, int] = dict(defaults)
    if isinstance(raw, Mapping):
        for platform, value in raw.items():
            key = str(platform).strip().lower()
            if key not in out:
                continue
            try:
                seconds = int(value)
            except (TypeError, ValueError):
                continue
            if low <= seconds <= high:
                out[key] = seconds
    return out


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
        legacy_heartbeat = int(data.get("heartbeat_interval_seconds", HEARTBEAT_INTERVAL_DEFAULT))
        heartbeat_defaults = dict(PLATFORM_HEARTBEAT_DEFAULTS)
        heartbeat_defaults["windows"] = legacy_heartbeat
        platform_heartbeat = _normalized_platform_intervals(
            data.get("platform_heartbeat_intervals"),
            heartbeat_defaults,
            low=HEARTBEAT_INTERVAL_MIN,
            high=HEARTBEAT_INTERVAL_MAX,
        )
        platform_inventory = _normalized_platform_intervals(
            data.get("platform_inventory_intervals"),
            PLATFORM_INVENTORY_DEFAULTS,
            low=INVENTORY_INTERVAL_MIN,
            high=INVENTORY_INTERVAL_MAX,
        )
        return {
            "heartbeat_interval_seconds": platform_heartbeat["windows"],
            "platform_heartbeat_intervals": platform_heartbeat,
            "platform_inventory_intervals": platform_inventory,
            "online_threshold_minutes": ONLINE_THRESHOLD_MINUTES,
            "stale_threshold_minutes": STALE_THRESHOLD_MINUTES,
            "remote_support_managed_password_enabled": bool(
                data.get(
                    "remote_support_managed_password_enabled",
                    REMOTE_SUPPORT_MANAGED_PASSWORD_DEFAULT,
                )
            ),
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
        platform_map = dict(get_policy()["platform_heartbeat_intervals"])
        platform_map["windows"] = seconds
        data["platform_heartbeat_intervals"] = platform_map
        _persist(data)
    return get_policy()


def set_policy(
    *,
    heartbeat_interval_seconds: Optional[int] = None,
    platform_heartbeat_intervals: Optional[Mapping[str, int]] = None,
    platform_inventory_intervals: Optional[Mapping[str, int]] = None,
    remote_support_managed_password_enabled: Optional[bool] = None,
) -> dict:
    with _lock:
        data = _load()
        current = get_policy()
        if heartbeat_interval_seconds is not None:
            if not (HEARTBEAT_INTERVAL_MIN <= heartbeat_interval_seconds <= HEARTBEAT_INTERVAL_MAX):
                raise ValueError(
                    f"heartbeat_interval_seconds must be between "
                    f"{HEARTBEAT_INTERVAL_MIN} and {HEARTBEAT_INTERVAL_MAX}, got {heartbeat_interval_seconds}"
                )
            data["heartbeat_interval_seconds"] = heartbeat_interval_seconds
            platform_map = dict(current["platform_heartbeat_intervals"])
            platform_map["windows"] = heartbeat_interval_seconds
            data["platform_heartbeat_intervals"] = platform_map
        if platform_heartbeat_intervals is not None:
            data["platform_heartbeat_intervals"] = _validate_platform_intervals(
                platform_heartbeat_intervals,
                current["platform_heartbeat_intervals"],
                low=HEARTBEAT_INTERVAL_MIN,
                high=HEARTBEAT_INTERVAL_MAX,
                label="platform_heartbeat_intervals",
            )
            data["heartbeat_interval_seconds"] = data["platform_heartbeat_intervals"]["windows"]
        if platform_inventory_intervals is not None:
            data["platform_inventory_intervals"] = _validate_platform_intervals(
                platform_inventory_intervals,
                current["platform_inventory_intervals"],
                low=INVENTORY_INTERVAL_MIN,
                high=INVENTORY_INTERVAL_MAX,
                label="platform_inventory_intervals",
            )
        if remote_support_managed_password_enabled is not None:
            data["remote_support_managed_password_enabled"] = remote_support_managed_password_enabled
        _persist(data)
    return get_policy()


def _validate_platform_intervals(
    incoming: Mapping[str, int],
    current: Mapping[str, int],
    *,
    low: int,
    high: int,
    label: str,
) -> Dict[str, int]:
    out = dict(current)
    if not isinstance(incoming, Mapping):
        raise ValueError(f"{label} must be an object")
    for platform, value in incoming.items():
        key = str(platform).strip().lower()
        if key not in PLATFORM_HEARTBEAT_DEFAULTS:
            raise ValueError(f"Unsupported platform in {label}: {platform!r}")
        try:
            seconds = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{label}.{key} must be an integer")
        if not (low <= seconds <= high):
            raise ValueError(f"{label}.{key} must be between {low} and {high}, got {seconds}")
        out[key] = seconds
    return out


def get_heartbeat_interval(platform: Optional[str]) -> int:
    platform_id = _policy_platform_key(platform)
    return get_policy()["platform_heartbeat_intervals"].get(platform_id, HEARTBEAT_INTERVAL_DEFAULT)


def get_inventory_interval(platform: Optional[str]) -> int:
    platform_id = _policy_platform_key(platform)
    return get_policy()["platform_inventory_intervals"].get(platform_id, INVENTORY_INTERVAL_DEFAULT)


def _policy_platform_key(platform: Optional[str]) -> str:
    p = (platform or "windows").strip().lower()
    if "routeros" in p or "mikrotik" in p:
        return "mikrotik"
    if "darwin" in p or "macos" in p:
        return "macos"
    if p in PLATFORM_HEARTBEAT_DEFAULTS:
        return p
    return "windows"


def reset_for_testing(tmp_path: Optional[str] = None) -> None:
    """Reset in-memory state. For tests only — not called in production."""
    global _policy, _POLICY_FILE
    _policy = None
    if tmp_path is not None:
        _POLICY_FILE = tmp_path
