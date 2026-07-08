"""MikroTik adapter — the first PROXY-managed platform (Phase 7).

Unlike Windows/Linux (native agents), MikroTik is managed by a proxy adapter:
a future customer-side process speaks the RouterOS API and reports through the
SAME enroll/heartbeat contract. This class is the backend half — classification
and capability mapping — proving the adapter contract is platform-neutral.

Phase 7 boundary: NO RouterOS API / SSH / Winbox / credential code here. Those
plug in later without touching this contract. A RouterOS device is neither a
server nor a client PC; it classifies UNASSIGNED at device_type level and lands
under the tree's Network category (see _tree_category_case / _platform_class_case).
"""

from app.models.device import DeviceType
from app.schemas.agent import AgentHeartbeatPayload
from app.services.platform_adapters.base import PlatformAdapter


class MikroTikAdapter(PlatformAdapter):
    platform_id = "mikrotik"
    is_proxy = True  # managed via a proxy adapter, not a native agent

    def classify_device_type(self, payload: AgentHeartbeatPayload) -> DeviceType:
        # Network gear is neither SERVER nor CLIENT; the tree Network category
        # (platform-based) is what places it — not device_type.
        return DeviceType.UNASSIGNED
