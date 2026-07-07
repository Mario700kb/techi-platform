"""Platform Adapters — per-platform behavior behind one dispatch point.

Contract (PLATFORM-EXPANSION-AUDIT.md §1/§7): services stay platform-agnostic
and call `get_adapter(platform_value)`; each adapter owns its platform's
logic. The Windows adapter is the existing production behavior, unchanged.
Dispatch is used only when FEATURE_PLATFORM_CORE is enabled — with the flag
off, services run their legacy code paths bit-identically.
"""

from app.services.platform_adapters.base import PlatformAdapter
from app.services.platform_adapters.registry import get_adapter

__all__ = ["PlatformAdapter", "get_adapter"]
