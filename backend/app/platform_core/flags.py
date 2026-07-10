"""Feature-flag helpers for the Platform Expansion.

Flags are env-driven booleans on ``app.core.config.Settings`` (audit §11):
default OFF, no DB-backed flags, and a flag is effective only when its
dependencies are also enabled — so partially-configured environments fail
closed rather than exposing half-wired features.
"""

from typing import Dict, Tuple

from app.core.config import settings

# flag -> flags that must also be ON for it to take effect (audit §11 table).
FEATURE_DEPENDENCIES: Dict[str, Tuple[str, ...]] = {
    "FEATURE_PLATFORM_CORE": (),
    "FEATURE_LINUX": ("FEATURE_PLATFORM_CORE",),
    "FEATURE_VAULT": ("FEATURE_PLATFORM_CORE",),
    "FEATURE_TERMINAL": ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT"),
    "FEATURE_MIKROTIK": ("FEATURE_PLATFORM_CORE", "FEATURE_VAULT"),
    "FEATURE_STORAGE": ("FEATURE_PLATFORM_CORE", "FEATURE_VAULT"),
    "FEATURE_HYPERVISOR": ("FEATURE_PLATFORM_CORE",),
    "FEATURE_NOTIFICATIONS": (),
}


def feature_enabled(flag: str) -> bool:
    """True only when ``flag`` and all of its dependencies are ON.

    Unknown flag names are always False (fail closed).
    """
    if flag not in FEATURE_DEPENDENCIES:
        return False
    if not bool(getattr(settings, flag, False)):
        return False
    return all(bool(getattr(settings, dep, False)) for dep in FEATURE_DEPENDENCIES[flag])
