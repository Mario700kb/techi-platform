"""Component Package Integration (Platform Components — Operational, Milestone 11).

Ties the component action layer to the Package Registry, read-only, reusing the
existing sources — it introduces NO new storage and does NOT modify the STABLE
Desired-State resolver (`component_state_service.py`) or the Package Registry.

Two jobs:

  * **Status** — per component on a device: Installed, Desired, Available versions
    and Outdated detection. Installed/Desired/Outdated come straight from the
    STABLE ``ComponentStateService`` (reused as-is). *Available* is the newest
    version present in the manifest (active OR inactive) for the component's
    file-types on the device's platform — so an uploaded-but-not-activated newer
    package surfaces as "available beyond desired".

  * **Payload enrichment** — for version-changing operations (install / update /
    reinstall), the queued action's payload is enriched with the active package's
    ``version`` (and ``target_sha256`` when present) so ``self_update`` /
    ``deploy_remote_support`` actually target the Desired (active) package. The
    operator's explicit parameters always win; enrichment only fills gaps.

The STABLE ``ComponentStateService`` privates (platform + file-type mapping) are
*read* here to avoid duplicating that single source — never modified.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.device import Device
from app.platform_core.action_resolver import ComponentActionError, ComponentActionErrorCode
from app.platform_core.components import ComponentHealth, LifecycleOperation
from app.schemas.agent_package import AgentFileType, AgentPackageOut
from app.services.agent_package_service import AgentPackageService
from app.services.component_state_service import (
    ComponentStateService,
    _DESIRED_FILE_TYPE_ORDER,
    _package_platform,
)

# Operations whose intent is to reach a specific package version. These get the
# active-package version/sha injected into the payload when the operator did not
# pin one explicitly.
VERSION_CHANGING_OPERATIONS = frozenset(
    {LifecycleOperation.INSTALL, LifecycleOperation.UPDATE, LifecycleOperation.REINSTALL}
)
REMOTE_SUPPORT_PACKAGE_OPERATIONS = frozenset(
    {
        LifecycleOperation.INSTALL,
        LifecycleOperation.UPDATE,
        LifecycleOperation.REPAIR,
        LifecycleOperation.REINSTALL,
    }
)
def _version_key(value: str):
    """Sortable key for a dotted-numeric version; unparseable → lowest."""
    try:
        return tuple(int(p) for p in value.strip().lstrip("vV").split("."))
    except (ValueError, AttributeError):
        return ()


@dataclass(frozen=True)
class ComponentPackageStatus:
    component_id: str
    installed_version: Optional[str]
    desired_version: Optional[str]
    available_version: Optional[str]
    outdated: bool


class ComponentPackageService:
    def __init__(self, db: Session):
        self.db = db
        self._states = ComponentStateService(db)
        self._packages = AgentPackageService()

    def active_package(
        self, component_id: str, device_platform: Optional[str]
    ) -> Optional[AgentPackageOut]:
        """The active (Desired) package for a component on a device's platform, in
        the same file-type precedence the Desired-State resolver uses."""
        pkg_platform = _package_platform(device_platform)
        if pkg_platform is None:
            return None
        for file_type in _DESIRED_FILE_TYPE_ORDER.get(component_id, []):
            package = self._packages.latest_active(pkg_platform, file_type=file_type)
            if package is not None:
                return package
        return None

    def available_version(
        self, component_id: str, device_platform: Optional[str]
    ) -> Optional[str]:
        """Highest version present in the manifest (active OR inactive) for the
        component's file-types on this platform, or None."""
        pkg_platform = _package_platform(device_platform)
        if pkg_platform is None:
            return None
        file_types = set(_DESIRED_FILE_TYPE_ORDER.get(component_id, []))
        if not file_types:
            return None
        candidates: List[AgentPackageOut] = [
            p
            for p in self._packages.list_packages(include_inactive=True)
            if p.platform.value == pkg_platform and p.file_type.value in file_types
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda p: _version_key(p.version)).version

    def status_for(self, device: Device, component_id: str) -> ComponentPackageStatus:
        """Installed / Desired / Available / Outdated for one component on a device.
        Installed/Desired/Outdated are reused from the STABLE Desired-State resolver."""
        states = {s.component_id: s for s in self._states.resolve_for_device(device)}
        state = states.get(component_id)
        installed = state.installed_version if state else None
        desired = state.desired_version if state else None
        outdated = bool(state and state.health == ComponentHealth.OUTDATED)
        available = self.available_version(component_id, device.platform)
        return ComponentPackageStatus(
            component_id=component_id,
            installed_version=installed,
            desired_version=desired,
            available_version=available,
            outdated=outdated,
        )

    def enrichment_for(
        self, component_id: str, device: Any, operation: LifecycleOperation
    ) -> Dict[str, Any]:
        """Payload fields to inject for a version-changing operation.

        * agent + self_update -> the COMPLETE self_update payload
          (download_url/version/sha256), built by the SINGLE source of truth
          shared with Command Center (see :meth:`_agent_self_update_enrichment`).
        * remote_support -> the full MSI deploy payload.
        * anything else version-changing -> the active package's ``version``
          (+ ``target_sha256`` when known).

        Empty dict for non-version-changing ops or when no active package exists
        (inert). Accepts either a ``Device`` (real callers) or a bare platform
        string (the remote_support/generic unit-test seams)."""
        device_platform = getattr(device, "platform", device)
        if component_id == "remote_support" and operation in REMOTE_SUPPORT_PACKAGE_OPERATIONS:
            return self._remote_support_msi_enrichment(device_platform, operation)
        if operation not in VERSION_CHANGING_OPERATIONS:
            return {}
        if component_id == "agent":
            return self._agent_self_update_enrichment(device)
        package = self.active_package(component_id, device_platform)
        if package is None:
            return {}
        enrichment: Dict[str, Any] = {"version": package.version}
        if package.sha256:
            enrichment["target_sha256"] = package.sha256
        return enrichment

    @staticmethod
    def _agent_self_update_enrichment(device: Any) -> Dict[str, Any]:
        """Reuse the EXACT self_update payload builder Command Center uses, so the
        Device Drawer's Update queues the same complete payload
        (download_url/version/sha256) instead of the partial
        ``{version, target_sha256}`` that made the agent fail with
        ``self_update: missing 'download_url' parameter``.

        Inert ({}) when the shared builder cannot produce a payload (e.g. no
        active agent binary, or a bare platform string in a unit-test seam),
        preserving this method's prior non-raising contract."""
        if not hasattr(device, "id"):
            return {}
        # Lazy import avoids a module-level cycle (agent_command_service imports
        # package/schema layers that ultimately reference this module's siblings).
        from app.services.agent_command_service import AgentCommandService

        try:
            _default, per_device = AgentCommandService._build_self_update_payloads([device])
        except ValueError:
            return {}
        return dict(per_device.get(device.id, {}))

    def _remote_support_msi_enrichment(
        self, device_platform: Optional[str], operation: LifecycleOperation
    ) -> Dict[str, Any]:
        package = self.active_package("remote_support", device_platform)
        if package is None or package.file_type.value != AgentFileType.REMOTE_SUPPORT_MSI.value:
            raise ComponentActionError(
                ComponentActionErrorCode.PACKAGE_UNAVAILABLE,
                "no active Remote Support MSI package",
                component_id="remote_support",
                operation=operation.value,
            )

        base_url = (settings.PUBLIC_BACKEND_URL or "").rstrip("/")
        missing = []
        product_version = package.product_version or package.version
        if not product_version:
            missing.append("product_version")
        if not package.sha256:
            missing.append("sha256")
        if not package.product_code:
            missing.append("product_code")
        if not package.upgrade_code:
            missing.append("upgrade_code")
        if not base_url:
            missing.append("PUBLIC_BACKEND_URL")
        if not settings.RUSTDESK_SERVER_HOST:
            missing.append("RUSTDESK_SERVER_HOST")
        if not settings.RUSTDESK_PUBLIC_KEY:
            missing.append("RUSTDESK_PUBLIC_KEY")
        if missing:
            raise ComponentActionError(
                ComponentActionErrorCode.PACKAGE_METADATA_INCOMPLETE,
                "active Remote Support MSI metadata is incomplete",
                component_id="remote_support",
                operation=operation.value,
            )

        return {
            "version": product_version,
            "sha256": package.sha256,
            "target_sha256": package.sha256,
            "msi_url": f"{base_url}{self._packages.remote_support_msi_download_url()}",
            "msi_version": product_version,
            # Compatibility with Windows agents that run the dedicated
            # reinstall recovery pipeline. They resolve the active package from
            # these explicit Remote Support MSI keys before any destructive
            # reinstall phase starts.
            "remote_support_msi_version": product_version,
            "remote_support_msi_filename": package.filename,
            "remote_support_msi_sha256": package.sha256,
            "product_guid": package.product_code,
            "product_code": package.product_code,
            "upgrade_code": package.upgrade_code,
            "product_name": package.product_name,
            "rendezvous_server": settings.RUSTDESK_SERVER_HOST,
            "key": settings.RUSTDESK_PUBLIC_KEY,
        }
