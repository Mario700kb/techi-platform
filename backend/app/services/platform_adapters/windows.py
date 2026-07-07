"""Windows adapter — the reference implementation.

`classify_windows_device_type` is the production classification logic moved
VERBATIM from `DeviceHeartbeatService.classify_device_type` (Phase 1 adapter
extraction, audit §1). The service's static method now delegates here, so the
behavior is provably identical on both the legacy path (flag off) and the
adapter path (flag on) — locked by tests/test_windows_device_classification.py.
"""

from typing import Optional

from app.models.device import DeviceType
from app.schemas.agent import AgentHeartbeatPayload
from app.services.platform_adapters.base import PlatformAdapter


def classify_windows_device_type(
    os_name: Optional[str],
    domain: Optional[str],
    *,
    os_version: Optional[str] = None,
    os_caption: Optional[str] = None,
    os_build: Optional[str] = None,
    windows_product_type: Optional[int] = None,
) -> DeviceType:
    if not domain or domain.strip().upper() == "WORKGROUP":
        return DeviceType.UNASSIGNED

    if windows_product_type in {2, 3}:
        return DeviceType.SERVER
    if windows_product_type == 1:
        return DeviceType.CLIENT

    normalized = " ".join(
        value.strip().lower()
        for value in (os_name, os_version, os_caption, os_build)
        if value and value.strip()
    )
    if "windows server" in normalized or "server" in normalized:
        return DeviceType.SERVER
    if "windows 10" in normalized or "windows 11" in normalized:
        return DeviceType.CLIENT

    return DeviceType.UNASSIGNED


class WindowsAdapter(PlatformAdapter):
    platform_id = "windows"

    def classify_device_type(self, payload: AgentHeartbeatPayload) -> DeviceType:
        return classify_windows_device_type(
            payload.os_name,
            payload.domain,
            os_version=payload.os_version,
            os_caption=payload.os_caption,
            os_build=payload.os_build,
            windows_product_type=payload.windows_product_type,
        )
