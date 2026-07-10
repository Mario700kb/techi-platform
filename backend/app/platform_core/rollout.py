"""Generic feature rollout scoping (Platform Expansion).

A `FEATURE_*` flag (app.platform_core.flags) is a single fleet-wide boolean —
it answers "does this feature exist in this deployment at all". It has no
concept of WHO the feature is live for. This module adds that second,
orthogonal axis, reusable by any feature that needs staged enablement
(Web Terminal today; Remote Actions / SSH Relay / future connector platforms
later) instead of each feature inventing its own allowlist shape.

Convention: for a feature flag `FEATURE_X`, the rollout is configured by four
settings sharing the same prefix (env-driven, same pattern as flags.py):

    FEATURE_X_SCOPE                 one of: none | device | group | client | fleet
    FEATURE_X_ALLOWED_DEVICE_IDS    comma-separated device IDs   (scope=device)
    FEATURE_X_ALLOWED_GROUPS        comma-separated group IDs    (scope=group)
    FEATURE_X_ALLOWED_CLIENTS       comma-separated client IDs   (scope=client)

Enforcement is server-side only — this module is imported by API/WS handlers,
never shipped to or trusted from the frontend. Default scope is "none" (fail
closed): a feature flag alone never grants access to anyone.
"""

from enum import Enum
from typing import Optional, Set

from app.core.config import settings


class RolloutScope(str, Enum):
    NONE = "none"
    DEVICE = "device"
    GROUP = "group"
    CLIENT = "client"
    FLEET = "fleet"


def _parse_ids(raw: Optional[str]) -> Set[int]:
    ids: Set[int] = set()
    for part in (raw or "").split(","):
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids


def get_scope(feature_prefix: str) -> RolloutScope:
    """Read `{feature_prefix}_SCOPE`. Unknown/missing values fail closed to NONE."""
    raw = str(getattr(settings, f"{feature_prefix}_SCOPE", "") or "none").strip().lower()
    try:
        return RolloutScope(raw)
    except ValueError:
        return RolloutScope.NONE


def is_rollout_allowed(
    feature_prefix: str,
    *,
    device_id: Optional[int] = None,
    group_id: Optional[int] = None,
    client_id: Optional[int] = None,
) -> bool:
    """True when the target identified by (device_id, group_id, client_id) is
    within the rollout scope configured for `feature_prefix`.

    This only decides WHO the feature is live for — callers must separately
    check the feature's own `FEATURE_*` flag (feature_enabled) and any
    capability/permission gates; those are unrelated axes.
    """
    scope = get_scope(feature_prefix)

    if scope == RolloutScope.NONE:
        return False
    if scope == RolloutScope.FLEET:
        return True
    if scope == RolloutScope.DEVICE:
        if device_id is None:
            return False
        return device_id in _parse_ids(getattr(settings, f"{feature_prefix}_ALLOWED_DEVICE_IDS", ""))
    if scope == RolloutScope.GROUP:
        if group_id is None:
            return False
        return group_id in _parse_ids(getattr(settings, f"{feature_prefix}_ALLOWED_GROUPS", ""))
    if scope == RolloutScope.CLIENT:
        if client_id is None:
            return False
        return client_id in _parse_ids(getattr(settings, f"{feature_prefix}_ALLOWED_CLIENTS", ""))
    return False


def is_device_in_rollout(feature_prefix: str, device) -> bool:
    """Convenience wrapper for a `Device` ORM instance (or any object with
    `id`/`group_id`/`client_id` attributes)."""
    return is_rollout_allowed(
        feature_prefix,
        device_id=getattr(device, "id", None),
        group_id=getattr(device, "group_id", None),
        client_id=getattr(device, "client_id", None),
    )
