"""Platform Core — foundation of the Platform Expansion (Phase 0).

Contract: docs/reference/PLATFORM-EXPANSION-AUDIT.md (DESIGN LOCKED).

This package is intentionally imported by NOTHING in the existing codebase
during Phase 0: it is dark infrastructure. Wiring into services happens in
later phases, gated by the feature flags in app.core.config.
"""

from app.platform_core.capabilities import (
    KNOWN_CAPABILITIES,
    is_known_capability,
    normalize_capabilities,
)
from app.platform_core.flags import FEATURE_DEPENDENCIES, feature_enabled
from app.platform_core.registry import (
    DEFAULT_PLATFORM_ID,
    PLATFORM_REGISTRY,
    PlatformDescriptor,
    is_known_platform,
    resolve_platform,
)

__all__ = [
    "KNOWN_CAPABILITIES",
    "is_known_capability",
    "normalize_capabilities",
    "FEATURE_DEPENDENCIES",
    "feature_enabled",
    "DEFAULT_PLATFORM_ID",
    "PLATFORM_REGISTRY",
    "PlatformDescriptor",
    "is_known_platform",
    "resolve_platform",
]
