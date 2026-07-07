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
            if _is_agent_outdated(device, active_agent_version, active_agent_sha256):
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
            loaded_at=utcnow(),
        )


def _active_agent_package():
    service = AgentPackageService()
    return service.latest_active("windows-amd64", file_type="agent_binary") or service.latest_active("windows-amd64")


def _active_agent_sha256(package) -> Optional[str]:
    if package is None or getattr(package.file_type, "value", None) != "agent_binary":
        return None
    return package.sha256


def _is_agent_outdated(device, active_version: Optional[str], active_sha256: Optional[str]) -> bool:
    if not active_version:
        return False
    if not device.agent_version or device.agent_version != active_version:
        return True
    if active_sha256:
        reported_sha = (device.agent_sha256 or "").strip().lower()
        return reported_sha != active_sha256.strip().lower()
    return False
