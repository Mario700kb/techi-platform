import json
import time
from collections import OrderedDict, defaultdict
from typing import Optional

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.time import utcnow
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import DeviceFleetOverview, DeviceStats, DeviceTreeCounts
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
        count_rows, health_rows = self.repository.get_overview_inputs(scope=scope)

        stats = {"total": 0, "online": 0, "stale": 0, "offline": 0}
        by_client: dict[int, int] = {}
        unassigned = 0
        for client_id, total, online, stale, offline in count_rows:
            stats["total"] += total
            stats["online"] += online
            stats["stale"] += stale
            stats["offline"] += offline
            if client_id is None:
                unassigned += total
            else:
                by_client[client_id] = total

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

        return DeviceFleetOverview(
            stats=DeviceStats(**stats),
            tree_counts=DeviceTreeCounts(
                total=stats["total"],
                unassigned=unassigned,
                by_client=by_client,
            ),
            critical=critical,
            warnings=warnings,
            average_health=round(score_total / len(health_inputs)) if health_inputs else None,
            needs_updates=needs_updates,
            loaded_at=utcnow(),
        )
