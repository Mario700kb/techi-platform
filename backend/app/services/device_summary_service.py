from collections import defaultdict
from typing import Optional

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.time import utcnow
from app.repositories.alert_repository import AlertRepository
from app.repositories.device_inventory_repository import DeviceInventoryRepository
from app.repositories.device_telemetry_repository import DeviceTelemetryRepository
from app.schemas.device import DeviceStats, DeviceTreeCounts, DevicesSummary
from app.schemas.device_inventory import PatchStatusSnapshot
from app.schemas.telemetry import DeviceHealthSummary
from app.services.device_health_score_service import compute_device_health_score
from app.services.device_inventory_service import DeviceInventoryService
from app.services.device_service import DeviceService


class DeviceSummaryService:
    def __init__(self, db: Session):
        self.db = db

    def get_summary(self, scope: Optional[AllowedScope] = None) -> DevicesSummary:
        devices = DeviceService(self.db).get_devices(limit=5000, scope=scope)
        device_ids = [device.id for device in devices]

        telemetry_by_device = {
            row.device_id: row
            for row in DeviceTelemetryRepository(self.db).get_latest_for_device_ids(device_ids)
        }
        inventory_by_device = {
            row.device_id: row
            for row in DeviceInventoryRepository(self.db).get_many_by_device_ids(device_ids)
        }
        alert_counts = AlertRepository(self.db).count_open_by_device_and_severity(device_ids)
        inventory_service = DeviceInventoryService(self.db)

        stats = {"total": len(devices), "online": 0, "stale": 0, "offline": 0}
        by_client = defaultdict(int)
        unassigned = 0
        health = []
        patches = []

        for device in devices:
            freshness = str(device.freshness_state)
            if freshness.startswith("DeviceFreshnessState."):
                freshness = freshness.rsplit(".", 1)[-1].lower()
            stats[freshness if freshness in {"online", "stale", "offline"} else "offline"] += 1

            client_id = getattr(device, "resolved_client_id", None) or device.client_id
            if client_id is None:
                unassigned += 1
            else:
                by_client[client_id] += 1

            telemetry = telemetry_by_device.get(device.id)
            inventory = inventory_by_device.get(device.id)
            score, state, _ = compute_device_health_score(
                device,
                telemetry,
                alert_counts.get(device.id, {}),
                inventory,
            )
            health.append(DeviceHealthSummary(
                device_id=device.id,
                health_score=score,
                health_state=state,
                cpu_percent=telemetry.cpu_percent if telemetry else None,
                ram_percent=telemetry.ram_percent if telemetry else None,
                disk_percent=telemetry.disk_percent if telemetry else None,
                uptime_seconds=telemetry.uptime_seconds if telemetry else None,
                heartbeat_latency_ms=telemetry.heartbeat_latency_ms if telemetry else None,
                computed_at=telemetry.created_at if telemetry else None,
            ))
            patches.append(
                inventory_service.parse_patch_status(
                    inventory.patch_json if inventory else None,
                    device.id,
                )
            )

        return DevicesSummary(
            devices=devices,
            stats=DeviceStats(**stats),
            health=health,
            patches=patches,
            tree_counts=DeviceTreeCounts(
                total=len(devices),
                unassigned=unassigned,
                by_client=dict(by_client),
            ),
            loaded_at=utcnow(),
        )
