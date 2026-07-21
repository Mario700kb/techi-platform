"""Desired-State resolution for Platform Components (foundation, read-only).

For a device, this computes — per managed component — the Installed Version, the
Desired Version, and the derived Health/Status. It is purely observational:

  * Installed Version  — read from the device row the heartbeat already fills
    (agent_version / rustdesk_version). Nothing is written; the heartbeat,
    enrollment, action queue, and agent are untouched.
  * Desired Version    — the active package version for the component on the
    device's platform, resolved via the existing AgentPackageService (the same
    file-based manifest, no new source of truth).
  * Health / Status    — derived by the pure Component Registry model
    (derive_health / status_label). No policy engine, no auto-update, no
    enforcement — this only reports.

There is NO migration: every input already exists on the device row and in the
package manifest. This service reuses the Component Registry for classification
and the Package Registry for versions; it introduces no new storage.
"""
from dataclasses import dataclass
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.platform_core.components import (
    ComponentDescriptor,
    ComponentHealth,
    build_component_state,
    components_for_platform,
    status_label,
)
from app.services.agent_package_service import AgentPackageService

# Which device column holds each component's INSTALLED version. This is the one
# place that bridges a component id to the heartbeat-filled device field.
_INSTALLED_VERSION_ATTR = {
    "agent": "agent_version",
    "remote_support": "rustdesk_version",
}

# Preferred active file_type order used to resolve the DESIRED version per
# component. latest_active() filters by platform, so a file_type that does not
# exist on the resolved platform simply returns None and we fall through — e.g.
# remote_support_msi matches on Windows, remote_support_pkg/dmg on macOS.
_DESIRED_FILE_TYPE_ORDER = {
    "agent": ["agent_binary", "msi"],
    "remote_support": ["remote_support_msi", "remote_support_pkg", "remote_support_dmg"],
}


@dataclass(frozen=True)
class ComponentDeviceState:
    component_id: str
    display_name: str
    icon_key: str
    installed_version: Optional[str]
    desired_version: Optional[str]
    health: ComponentHealth
    status: str  # capitalized display label (Current/Outdated/Missing/Unknown)


def _normalize_platform(device_platform: Optional[str]) -> str:
    """Device platform → registry platform id (absence ⇒ windows)."""
    p = (device_platform or "windows").strip().lower()
    if p.startswith("windows"):
        return "windows"
    if p.startswith("linux"):
        return "linux"
    if p.startswith("darwin") or p == "macos":
        return "darwin"
    return p


def _package_platform(device_platform: Optional[str]) -> Optional[str]:
    """Device platform → the AgentPackage platform used to look up active
    packages. Returns None for platforms that have no agent/RS packages."""
    p = _normalize_platform(device_platform)
    if p == "windows":
        return "windows-amd64"
    if p == "linux":
        return "linux-amd64"
    if p == "darwin":
        return "darwin-arm64"
    return None


class ComponentStateService:
    """Read-only resolver. No writes, no migration, no enforcement."""

    def __init__(self, db: Session):
        self.db = db
        self._packages = AgentPackageService()

    def _installed_version(self, component_id: str, device: Device) -> Optional[str]:
        attr = _INSTALLED_VERSION_ATTR.get(component_id)
        if attr is None:
            return None
        value = getattr(device, attr, None)
        return value or None

    def _desired_version(self, component_id: str, device_platform: Optional[str]) -> Optional[str]:
        pkg_platform = _package_platform(device_platform)
        if pkg_platform is None:
            return None
        for file_type in _DESIRED_FILE_TYPE_ORDER.get(component_id, []):
            package = self._packages.latest_active(pkg_platform, file_type=file_type)
            if package is not None:
                return package.version
        return None

    def _state_for(self, descriptor: ComponentDescriptor, device: Device) -> ComponentDeviceState:
        installed = self._installed_version(descriptor.id, device)
        desired = self._desired_version(descriptor.id, device.platform)
        model = build_component_state(descriptor.id, installed, desired)
        return ComponentDeviceState(
            component_id=descriptor.id,
            display_name=descriptor.display_name,
            icon_key=descriptor.icon_key,
            installed_version=model.installed_version,
            desired_version=model.desired_version,
            health=model.health,
            status=status_label(model.health),
        )

    def resolve_for_device(self, device: Device) -> List[ComponentDeviceState]:
        """Per-component desired-state for a device, in registry order. Devices on
        platforms with no managed components (e.g. MikroTik connectors) return []."""
        platform_id = _normalize_platform(device.platform)
        return [
            self._state_for(descriptor, device)
            for descriptor in components_for_platform(platform_id)
        ]
