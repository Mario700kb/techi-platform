"""Linux adapter — classification skeleton for Phase 2/3.

Unreachable in production until FEATURE_LINUX devices exist (dispatch is by
the device's platform value, and Linux enrollment ships in Phase 2). The
heuristic below implements the audit §13 auto-grouping rule at MVP level:
server distros → SERVER, desktop variants → CLIENT, no signal → UNASSIGNED
(conservative: an operator sees it under Unassigned rather than misfiled).
"""

from app.models.device import DeviceType
from app.schemas.agent import AgentHeartbeatPayload
from app.services.platform_adapters.base import PlatformAdapter

_DESKTOP_MARKERS = ("desktop", "workstation", "kde", "gnome", "xfce")


class LinuxAdapter(PlatformAdapter):
    platform_id = "linux"

    def classify_device_type(self, payload: AgentHeartbeatPayload) -> DeviceType:
        normalized = " ".join(
            value.strip().lower()
            for value in (payload.os_name, payload.os_version, payload.os_caption, payload.os_build)
            if value and value.strip()
        )
        if not normalized:
            return DeviceType.UNASSIGNED
        if "server" in normalized:
            return DeviceType.SERVER
        if any(marker in normalized for marker in _DESKTOP_MARKERS):
            return DeviceType.CLIENT
        return DeviceType.UNASSIGNED
