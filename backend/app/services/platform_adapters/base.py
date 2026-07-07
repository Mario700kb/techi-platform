from abc import ABC, abstractmethod
from typing import Any, Dict

from app.models.device import DeviceType
from app.platform_core.capabilities import normalize_capabilities
from app.platform_core.registry import PLATFORM_REGISTRY
from app.schemas.agent import AgentHeartbeatPayload


class PlatformAdapter(ABC):
    """Per-platform behavior consumed by platform-agnostic services.

    Isolation rule (audit §7): an adapter may know only its own platform and
    Platform Core — never another adapter.
    """

    platform_id: str

    @abstractmethod
    def classify_device_type(self, payload: AgentHeartbeatPayload) -> DeviceType:
        """Server / client / unassigned classification from heartbeat facts."""

    def normalize_capabilities(self, reported: Any) -> Dict[str, str]:
        """Validated capabilities, restricted to what this platform may report."""
        allowed = PLATFORM_REGISTRY[self.platform_id].allowed_capabilities
        return {
            name: version
            for name, version in normalize_capabilities(reported).items()
            if name in allowed
        }
