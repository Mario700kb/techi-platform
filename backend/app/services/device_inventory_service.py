import json
import logging
from datetime import datetime
from app.core.time import utcnow
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.repositories.device_inventory_repository import DeviceInventoryRepository
from app.schemas.device_inventory import (
    DeviceInventoryResponse,
    PatchStatusSnapshot,
    ProcessSnapshot,
    ServiceSnapshot,
    SoftwareSnapshot,
)

logger = logging.getLogger(__name__)


class DeviceInventoryService:
    def __init__(self, db: Session):
        self.repo = DeviceInventoryRepository(db)

    def save_snapshot(
        self,
        device_id: int,
        processes: Optional[List[Dict[str, Any]]],
        services: Optional[List[Dict[str, Any]]],
        software: Optional[List[Dict[str, Any]]] = None,
        patch_status: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not processes and not services and not software and not patch_status:
            return
        self.repo.upsert(
            device_id=device_id,
            processes_json=json.dumps(processes) if processes else None,
            services_json=json.dumps(services) if services else None,
            software_json=json.dumps(software) if software else None,
            patch_json=json.dumps(patch_status) if patch_status else None,
            collected_at=utcnow(),
        )

    def get_inventory(self, device_id: int) -> DeviceInventoryResponse:
        obj = self.repo.get_by_device(device_id)
        if obj is None:
            return DeviceInventoryResponse(device_id=device_id)

        processes: List[ProcessSnapshot] = []
        if obj.processes_json:
            try:
                raw = json.loads(obj.processes_json)
                processes = [ProcessSnapshot(**p) for p in raw if isinstance(p, dict)]
            except Exception:
                logger.warning("device %d: failed to parse processes_json", device_id)

        services: List[ServiceSnapshot] = []
        if obj.services_json:
            try:
                raw = json.loads(obj.services_json)
                services = [ServiceSnapshot(**s) for s in raw if isinstance(s, dict)]
            except Exception:
                logger.warning("device %d: failed to parse services_json", device_id)

        software: List[SoftwareSnapshot] = []
        if obj.software_json:
            try:
                raw = json.loads(obj.software_json)
                software = [SoftwareSnapshot(**s) for s in raw if isinstance(s, dict)]
            except Exception:
                logger.warning("device %d: failed to parse software_json", device_id)

        patch = self._parse_patch_status(obj.patch_json, device_id)
        return DeviceInventoryResponse(
            device_id=device_id,
            processes=processes,
            services=services,
            software=software,
            pending_updates=patch.pending_updates,
            reboot_required=patch.reboot_required,
            last_update_at=patch.last_update_at,
            patch_state=patch.patch_state,
            collected_at=obj.collected_at,
        )

    def get_patch_status_many(self, device_ids: List[int]) -> List[PatchStatusSnapshot]:
        rows = self.repo.get_many_by_device_ids(device_ids)
        by_device = {row.device_id: row for row in rows}
        result: List[PatchStatusSnapshot] = []
        for device_id in device_ids:
            row = by_device.get(device_id)
            patch = self._parse_patch_status(row.patch_json if row else None, device_id)
            patch.device_id = device_id
            result.append(patch)
        return result

    def _parse_patch_status(self, raw_json: Optional[str], device_id: int) -> PatchStatusSnapshot:
        if not raw_json:
            return PatchStatusSnapshot(device_id=device_id)
        try:
            raw = json.loads(raw_json)
            if isinstance(raw, dict):
                return PatchStatusSnapshot(device_id=device_id, **raw)
        except Exception:
            logger.warning("device %d: failed to parse patch_json", device_id)
        return PatchStatusSnapshot(device_id=device_id)
