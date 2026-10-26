import json
import logging
from datetime import datetime, timedelta
from app.core.time import ensure_utc, utcnow
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
from app.schemas.device_health import DeviceHealth
from app.schemas.security_posture import SecurityPosture
from app.services.device_health import health_from_json, merge_health
from app.services.security_posture import posture_from_json

logger = logging.getLogger(__name__)

AGENT_PRODUCT_NAME = "TECHI Agent"


def with_running_agent_version(software: Optional[List[Dict[str, Any]]], agent_version: Optional[str]) -> Optional[List[Dict[str, Any]]]:
    """Windows lists the TECHI Agent MSI at the version it was installed with
    (e.g. 2.1.20.0): self_update swaps only techi-agent.exe, never the MSI
    registration. The agent that sent the list knows its own version, so that
    one entry shows the version that actually runs."""
    version = (agent_version or "").strip()
    if not software or not version:
        return software
    fixed = []
    for app in software:
        if (
            isinstance(app, dict)
            and str(app.get("name") or "").strip().lower() == AGENT_PRODUCT_NAME.lower()
            and str(app.get("publisher") or "").strip().upper().startswith("TECHI")
        ):
            app = {**app, "version": version}
        fixed.append(app)
    return fixed


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
        security_posture: Optional[SecurityPosture] = None,
        device_health: Optional[DeviceHealth] = None,
    ) -> Optional[SecurityPosture]:
        """Stores the snapshot. Returns the security posture stored before
        this one (when a new one came), so a change for the worse can be told."""
        if (
            not processes
            and not services
            and not software
            and not patch_status
            and security_posture is None
            and device_health is None
        ):
            return None
        now = utcnow()
        existing = self.repo.get_by_device(device_id) if (security_posture is not None or device_health is not None) else None
        previous_posture = posture_from_json(existing.security_json) if (existing is not None and security_posture is not None) else None
        security_json = None
        security_collected_at = None
        if security_posture is not None:
            security_json = security_posture.model_dump_json()
            security_collected_at = _posture_time(security_posture.collected_at, now)
        health_json = None
        if device_health is not None:
            previous = health_from_json(existing.health_json) if existing is not None else None
            health_json = merge_health(previous, device_health, now).model_dump_json()
        self.repo.upsert(
            device_id=device_id,
            processes_json=json.dumps(processes) if processes else None,
            services_json=json.dumps(services) if services else None,
            software_json=json.dumps(software) if software else None,
            patch_json=json.dumps(patch_status) if patch_status else None,
            collected_at=now,
            security_json=security_json,
            security_collected_at=security_collected_at,
            health_json=health_json,
            health_collected_at=now if health_json is not None else None,
        )
        return previous_posture

    def get_health(self, device_id: int) -> Optional[DeviceHealth]:
        obj = self.repo.get_by_device(device_id)
        return health_from_json(obj.health_json) if obj is not None else None

    def get_security_posture(self, device_id: int) -> Optional[SecurityPosture]:
        obj = self.repo.get_by_device(device_id)
        return posture_from_json(obj.security_json) if obj is not None else None

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

        patch = self.parse_patch_status(obj.patch_json, device_id)
        security = self.parse_security_posture(obj.security_json, device_id)
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
            security_posture=security,
            security_collected_at=ensure_utc(obj.security_collected_at) if security else None,
        )

    def get_patch_status_many(self, device_ids: List[int]) -> List[PatchStatusSnapshot]:
        rows = self.repo.get_many_by_device_ids(device_ids)
        by_device = {row.device_id: row for row in rows}
        result: List[PatchStatusSnapshot] = []
        for device_id in device_ids:
            row = by_device.get(device_id)
            patch = self.parse_patch_status(row.patch_json if row else None, device_id)
            patch.device_id = device_id
            result.append(patch)
        return result

    def parse_patch_status(self, raw_json: Optional[str], device_id: int) -> PatchStatusSnapshot:
        if not raw_json:
            return PatchStatusSnapshot(device_id=device_id)
        try:
            raw = json.loads(raw_json)
            if isinstance(raw, dict):
                return PatchStatusSnapshot(device_id=device_id, **raw)
        except Exception:
            logger.warning("device %d: failed to parse patch_json", device_id)
        return PatchStatusSnapshot(device_id=device_id)

    @staticmethod
    def parse_security_posture(raw_json: Optional[str], device_id: int) -> Optional[SecurityPosture]:
        posture = posture_from_json(raw_json)
        if raw_json and posture is None:
            logger.warning("device %d: failed to parse security_json", device_id)
        return posture


# An agent clock this far off is not believed; the receive time is stored.
_POSTURE_CLOCK_SKEW = timedelta(minutes=10)
_POSTURE_MAX_AGE = timedelta(days=7)


def _posture_time(reported: Optional[datetime], now: datetime) -> datetime:
    """When the posture was read, as naive UTC (the column's form)."""
    when = now
    if reported is not None:
        reported = ensure_utc(reported)
        if now - _POSTURE_MAX_AGE <= reported <= now + _POSTURE_CLOCK_SKEW:
            when = min(reported, now)
    return when.replace(tzinfo=None)
