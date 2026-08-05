import json
import time
from collections import OrderedDict, defaultdict
from typing import Optional

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.time import utcnow
from app.platform_core.flags import feature_enabled
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import DeviceFleetOverview, DeviceStats, DeviceTreeCounts
from app.services.agent_package_service import AgentPackageService
from app.services.device_health_score_service import compute_device_health_score


_overview_cache: OrderedDict[str, tuple[DeviceFleetOverview, float]] = OrderedDict()
_OVERVIEW_CACHE_TTL = 30.0
_OVERVIEW_CACHE_MAX_SIZE = 20


def _scope_cache_key(scope: Optional[AllowedScope]) -> str:
    if scope is None:
        return "global"
    return (
        f"c{sorted(scope.client_ids)}"
        f"g{sorted(scope.group_ids)}"
        f"d{sorted(scope.device_ids)}"
    )


def invalidate_overview_cache() -> None:
    _overview_cache.clear()


class DeviceOverviewService:
    def __init__(self, db: Session):
        self.repository = DeviceRepository(db)

    def get_overview(self, scope: Optional[AllowedScope] = None) -> DeviceFleetOverview:
        key = _scope_cache_key(scope)
        entry = _overview_cache.get(key)
        if entry is not None and time.monotonic() - entry[1] < _OVERVIEW_CACHE_TTL:
            _overview_cache.move_to_end(key)
            return entry[0]
        if entry is not None:
            _overview_cache.pop(key, None)

        overview = self._compute_overview(scope)
        _overview_cache[key] = (overview, time.monotonic())
        while len(_overview_cache) > _OVERVIEW_CACHE_MAX_SIZE:
            _overview_cache.popitem(last=False)
        return overview

    def _compute_overview(self, scope: Optional[AllowedScope]) -> DeviceFleetOverview:
        active_pkg = _active_agent_package()
        active_agent_version = active_pkg.version if active_pkg else None
        active_agent_sha256 = _active_agent_sha256(active_pkg)
        # Resolved once: both are cheap, query-free lookups, but the loop
        # below runs per device.
        agent_versions = _active_agent_versions()
        connector_versions = _active_connector_versions()

        count_rows, health_rows = self.repository.get_overview_inputs(scope=scope)

        stats = {"total": 0, "online": 0, "stale": 0, "offline": 0}
        by_client: dict[int, int] = {}
        by_client_category: dict[int, dict[str, int]] = {}
        unassigned = 0
        for client_id, category, total, online, stale, offline in count_rows:
            stats["total"] += total
            stats["online"] += online
            stats["stale"] += stale
            stats["offline"] += offline
            if client_id is None:
                unassigned += total
            else:
                by_client[client_id] = by_client.get(client_id, 0) + total
                by_client_category.setdefault(client_id, {})[category] = total

        health_inputs = {}
        for device, telemetry, inventory, severity, count in health_rows:
            entry = health_inputs.setdefault(
                device.id,
                {
                    "device": device,
                    "telemetry": telemetry,
                    "inventory": inventory,
                    "alerts": defaultdict(int),
                },
            )
            if severity is not None:
                severity_value = getattr(severity, "value", severity)
                entry["alerts"][severity_value] += count

        critical = 0
        warnings = 0
        score_total = 0
        needs_updates = 0
        agents_outdated = 0
        for entry in health_inputs.values():
            score, state, _ = compute_device_health_score(
                entry["device"],
                entry["telemetry"],
                dict(entry["alerts"]),
                entry["inventory"],
            )
            score_total += score
            if state == "critical":
                critical += 1
            elif state == "warning":
                warnings += 1
            inventory = entry["inventory"]
            if inventory is not None and inventory.patch_json:
                try:
                    patch = json.loads(inventory.patch_json)
                    if bool(patch.get("reboot_required")) or int(patch.get("pending_updates") or 0) > 0:
                        needs_updates += 1
                except (TypeError, ValueError, json.JSONDecodeError):
                    pass
            device = entry["device"]
            if _is_device_agent_outdated(
                device, active_agent_version, active_agent_sha256,
                agent_versions, connector_versions,
            ):
                agents_outdated += 1

        return DeviceFleetOverview(
            stats=DeviceStats(**stats),
            tree_counts=DeviceTreeCounts(
                total=stats["total"],
                unassigned=unassigned,
                by_client=by_client,
                by_client_category=by_client_category,
                # Extra aggregation query ONLY when Linux is enabled — the
                # overview stays a 2-query hot path in today's production.
                by_client_category_platform=(
                    self.repository.count_by_client_category_platform(scope=scope)
                    if feature_enabled("FEATURE_LINUX")
                    else {}
                ),
            ),
            critical=critical,
            warnings=warnings,
            average_health=round(score_total / len(health_inputs)) if health_inputs else None,
            needs_updates=needs_updates,
            agents_outdated=agents_outdated,
            active_agent_version=active_agent_version,
            active_agent_sha256=active_agent_sha256,
            active_connector_versions=connector_versions,
            active_agent_versions=agent_versions,
            loaded_at=utcnow(),
        )


def _active_agent_package():
    service = AgentPackageService()
    return service.latest_active("windows-amd64", file_type="agent_binary") or service.latest_active("windows-amd64")


def _active_connector_versions() -> dict:
    """{platform_id: latest_connector_version} for every connector platform
    that declares one (Platform Registry) — cheap, no query, no cache impact."""
    from app.platform_core.registry import PLATFORM_REGISTRY
    return {
        descriptor.id: descriptor.latest_connector_version
        for descriptor in PLATFORM_REGISTRY.values()
        if descriptor.latest_connector_version
    }


def _active_agent_versions() -> dict:
    """`{"<platform>:<architecture>": version}` for agent platforms whose latest
    version depends on the device's architecture — Linux today.

    Keyed by the architecture the device itself reports (`uname -m`) so the
    Device List can resolve a row directly, without the arch->package table
    being restated in TypeScript. Windows is deliberately absent: it keeps
    using `active_agent_version`, so its badges are unchanged.
    """
    from app.services import version_service

    versions = {}
    for architecture in version_service.linux_architectures():
        version = version_service.get_active_version("linux", architecture)
        if version:
            versions[f"linux:{architecture}"] = version
    return versions


def _active_agent_sha256(package) -> Optional[str]:
    if package is None or getattr(package.file_type, "value", None) != "agent_binary":
        return None
    return package.sha256


def _is_device_agent_outdated(
    device,
    windows_version: Optional[str],
    windows_sha256: Optional[str],
    agent_versions: dict,
    connector_versions: dict,
) -> bool:
    """Is THIS device behind the latest build for ITS platform?

    Every device used to be measured against the Windows package version, so a
    MikroTik connector on 1.0.0 and a Linux agent on 2.1.21 both counted as
    "needs agent update" against Windows' 2.1.20 — the AGENT UPDATE tile and
    the Needs Agent Update filter were inflated by every non-Windows device in
    the fleet (reported 2026-08-05).

    A platform with no known latest version is never called outdated: an
    unmeasurable device is not a stale one.
    """
    platform = (device.platform or "windows").strip().lower()
    if platform == "windows":
        return _is_agent_outdated(device, windows_version, windows_sha256)

    from app.services import version_service

    architecture = (device.architecture or "").strip().lower()
    active = agent_versions.get(f"{platform}:{architecture}") if architecture else None
    if active is None:
        active = connector_versions.get(platform)
    if not active:
        return False
    return version_service.compare_versions(device.agent_version, active) == "outdated"


def _is_agent_outdated(device, active_version: Optional[str], active_sha256: Optional[str]) -> bool:
    if not active_version:
        return False
    if not device.agent_version or device.agent_version != active_version:
        return True
    if active_sha256:
        reported_sha = (device.agent_sha256 or "").strip().lower()
        return reported_sha != active_sha256.strip().lower()
    return False
