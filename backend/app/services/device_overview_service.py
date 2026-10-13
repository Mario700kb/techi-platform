import json
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.swr_cache import SWRCache, scope_cache_key
from app.core.time import utcnow
from app.platform_core.flags import feature_enabled
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import DeviceFleetOverview, DeviceStats, DeviceTreeCounts
from app.services.agent_package_service import AgentPackageService
from app.services.device_health_score_service import compute_device_health_score


# Fresh for 30 seconds; after that the last overview is served at once while
# one background thread recomputes it, so no dashboard waits on the ~1s build.
_overview_cache: SWRCache[DeviceFleetOverview] = SWRCache("overview", ttl=30.0, max_age=300.0)


@dataclass(frozen=True)
class DeviceHealthIndexEntry:
    """Per-device signals the score engine derives in Python, kept so list
    filters and their counts can use them without recomputing per request."""

    score: int
    state: str
    patch_state: str
    has_pending_patches: bool
    critical_alerts: int
    agent_outdated: bool
    archived: bool


# One computation feeds the dashboard overview, the Devices quick filters and
# their counts, so a tile, a filter and its count can never disagree.
_health_index_cache: SWRCache[Dict[int, DeviceHealthIndexEntry]] = SWRCache("health_index", ttl=30.0, max_age=300.0)


def get_health_index(db: Session, scope: Optional[AllowedScope] = None) -> Dict[int, DeviceHealthIndexEntry]:
    return _health_index_cache.get(scope_cache_key(scope), db, lambda session: _compute_health_index(session, scope))


def _compute_health_index(db: Session, scope: Optional[AllowedScope]) -> Dict[int, DeviceHealthIndexEntry]:
    active_pkg = _active_agent_package()
    active_agent_version = active_pkg.version if active_pkg else None
    active_agent_sha256 = _active_agent_sha256(active_pkg)
    agent_versions = _active_agent_versions()
    connector_versions = _active_connector_versions()

    inputs: dict = {}
    for device, telemetry, inventory, severity, count in DeviceRepository(db).get_health_inputs(scope=scope):
        entry = inputs.setdefault(
            device.id,
            {"device": device, "telemetry": telemetry, "inventory": inventory, "alerts": defaultdict(int)},
        )
        if severity is not None:
            entry["alerts"][getattr(severity, "value", severity)] += count

    index: Dict[int, DeviceHealthIndexEntry] = {}
    for device_id, entry in inputs.items():
        device = entry["device"]
        alerts = dict(entry["alerts"])
        score, state, _ = compute_device_health_score(device, entry["telemetry"], alerts, entry["inventory"])
        patch = _parse_patch(entry["inventory"])
        index[device_id] = DeviceHealthIndexEntry(
            score=score,
            state=state,
            patch_state=str(patch.get("patch_state") or "unknown"),
            has_pending_patches=bool(patch.get("reboot_required")) or _int(patch.get("pending_updates")) > 0,
            critical_alerts=int(alerts.get("critical", 0)),
            agent_outdated=_is_device_agent_outdated(
                device, active_agent_version, active_agent_sha256, agent_versions, connector_versions,
            ),
            archived=bool(device.is_archived),
        )
    return index


def _parse_patch(inventory) -> dict:
    if inventory is None or not inventory.patch_json:
        return {}
    try:
        patch = json.loads(inventory.patch_json)
    except (TypeError, ValueError):
        return {}
    return patch if isinstance(patch, dict) else {}


def _int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def invalidate_overview_cache() -> None:
    _overview_cache.clear()
    _health_index_cache.clear()


def warm_overview_cache(db: Session) -> None:
    """Build the fleet-wide overview at startup so the first dashboard is instant."""
    _overview_cache.warm(scope_cache_key(None), db, lambda session: DeviceOverviewService(session)._compute_overview(None))


class DeviceOverviewService:
    def __init__(self, db: Session):
        self.db = db
        self.repository = DeviceRepository(db)

    def get_overview(self, scope: Optional[AllowedScope] = None) -> DeviceFleetOverview:
        return _overview_cache.get(scope_cache_key(scope), self.db,
                                   lambda session: DeviceOverviewService(session)._compute_overview(scope))

    def _compute_overview(self, scope: Optional[AllowedScope]) -> DeviceFleetOverview:
        active_pkg = _active_agent_package()
        active_agent_version = active_pkg.version if active_pkg else None
        active_agent_sha256 = _active_agent_sha256(active_pkg)
        agent_versions = _active_agent_versions()
        connector_versions = _active_connector_versions()

        count_rows = self.repository.get_fleet_counts(scope=scope)

        stats = {"total": 0, "online": 0, "stale": 0, "offline": 0}
        by_client: dict[int, int] = {}
        by_client_category: dict[int, dict[str, int]] = {}
        by_category: dict[str, int] = {}
        unassigned = 0
        for client_id, category, total, online, stale, offline in count_rows:
            stats["total"] += total
            stats["online"] += online
            stats["stale"] += stale
            stats["offline"] += offline
            by_category[category] = by_category.get(category, 0) + total
            if client_id is None:
                unassigned += total
            else:
                by_client[client_id] = by_client.get(client_id, 0) + total
                by_client_category.setdefault(client_id, {})[category] = total

        active_entries = [entry for entry in get_health_index(self.db, scope).values() if not entry.archived]
        critical = sum(1 for entry in active_entries if entry.state == "critical")
        warnings = sum(1 for entry in active_entries if entry.state == "warning")
        score_total = sum(entry.score for entry in active_entries)
        needs_updates = sum(1 for entry in active_entries if entry.has_pending_patches)
        agents_outdated = sum(1 for entry in active_entries if entry.agent_outdated)

        return DeviceFleetOverview(
            stats=DeviceStats(**stats),
            tree_counts=DeviceTreeCounts(
                total=stats["total"],
                unassigned=unassigned,
                by_client=by_client,
                by_client_category=by_client_category,
                by_category=by_category,
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
            average_health=round(score_total / len(active_entries)) if active_entries else None,
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
