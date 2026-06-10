from typing import List, Optional
from sqlalchemy.orm import Session

from app.models.device_telemetry import DeviceTelemetry


class DeviceTelemetryRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(
        self,
        device_id: int,
        cpu_percent: Optional[float] = None,
        ram_percent: Optional[float] = None,
        disk_percent: Optional[float] = None,
        uptime_seconds: Optional[int] = None,
        heartbeat_latency_ms: Optional[int] = None,
    ) -> DeviceTelemetry:
        obj = DeviceTelemetry(
            device_id=device_id,
            cpu_percent=cpu_percent,
            ram_percent=ram_percent,
            disk_percent=disk_percent,
            uptime_seconds=uptime_seconds,
            heartbeat_latency_ms=heartbeat_latency_ms,
        )
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def get_latest(self, device_id: int) -> Optional[DeviceTelemetry]:
        return (
            self.db.query(DeviceTelemetry)
            .filter(DeviceTelemetry.device_id == device_id)
            .order_by(DeviceTelemetry.created_at.desc())
            .first()
        )

    def get_recent_by_device(self, device_id: int, limit: int = 20) -> List[DeviceTelemetry]:
        return (
            self.db.query(DeviceTelemetry)
            .filter(DeviceTelemetry.device_id == device_id)
            .order_by(DeviceTelemetry.created_at.desc())
            .limit(limit)
            .all()
        )

    def get_latest_all(self) -> List[DeviceTelemetry]:
        return self.get_latest_for_device_ids()

    def get_latest_for_device_ids(self, device_ids: Optional[List[int]] = None) -> List[DeviceTelemetry]:
        if device_ids is not None and not device_ids:
            return []
        q = (
            self.db.query(DeviceTelemetry)
            .distinct(DeviceTelemetry.device_id)
            .order_by(DeviceTelemetry.device_id, DeviceTelemetry.created_at.desc())
        )
        if device_ids is not None:
            q = q.filter(DeviceTelemetry.device_id.in_(device_ids))
        return q.all()
