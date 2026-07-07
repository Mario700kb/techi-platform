import logging
from typing import Dict, Optional

from app.platform_core.registry import DEFAULT_PLATFORM_ID, resolve_platform
from app.services.platform_adapters.base import PlatformAdapter
from app.services.platform_adapters.linux import LinuxAdapter
from app.services.platform_adapters.windows import WindowsAdapter

logger = logging.getLogger(__name__)

_ADAPTERS: Dict[str, PlatformAdapter] = {
    adapter.platform_id: adapter for adapter in (WindowsAdapter(), LinuxAdapter())
}


def get_adapter(platform_value: Optional[str]) -> PlatformAdapter:
    """Adapter for a device's platform value.

    NULL/empty resolves to Windows (audit §8). Known platforms without an
    adapter yet (their phase hasn't shipped) and unknown values fall back to
    the Windows adapter — the legacy behavior — with a log line, so a rogue
    platform string can never change how the existing fleet is treated.
    """
    descriptor = resolve_platform(platform_value)
    if descriptor is None:
        logger.warning("Unknown platform value %r — using the Windows adapter", platform_value)
        return _ADAPTERS[DEFAULT_PLATFORM_ID]
    adapter = _ADAPTERS.get(descriptor.id)
    if adapter is None:
        logger.info("No adapter for platform %r yet — using the Windows adapter", descriptor.id)
        return _ADAPTERS[DEFAULT_PLATFORM_ID]
    return adapter
