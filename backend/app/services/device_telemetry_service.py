from typing import List, Optional, Tuple

from app.models.device_telemetry import DeviceTelemetry
from app.repositories.device_telemetry_repository import DeviceTelemetryRepository
from app.schemas.telemetry import DeviceHealth, DeviceHealthSummary, TelemetrySnapshot
from app.services.device_health_score_service import DeviceHealthScoreService

_CRITICAL_CPU = 90.0
_WARNING_CPU = 75.0
_CRITICAL_RAM = 90.0
_WARNING_RAM = 80.0
_CRITICAL_DISK = 95.0
_WARNING_DISK = 85.0


def compute_health(device_status: str, snapshot: Optional[DeviceTelemetry]) -> Tuple[str, List[str]]:
    if device_status == "offline":
        return "offline", []
    if snapshot is None:
        return "healthy", []

    reasons: List[str] = []
    severity = "healthy"

    if snapshot.cpu_percent is not None:
        if snapshot.cpu_percent > _CRITICAL_CPU:
            reasons.append(f"CPU critical: {snapshot.cpu_percent:.1f}%")
            severity = "critical"
        elif snapshot.cpu_percent > _WARNING_CPU:
            reasons.append(f"CPU elevated: {snapshot.cpu_percent:.1f}%")
            if severity == "healthy":
                severity = "warning"

    if snapshot.ram_percent is not None:
        if snapshot.ram_percent > _CRITICAL_RAM:
            reasons.append(f"RAM critical: {snapshot.ram_percent:.1f}%")
            severity = "critical"
        elif snapshot.ram_percent > _WARNING_RAM:
            reasons.append(f"RAM elevated: {snapshot.ram_percent:.1f}%")
            if severity == "healthy":
                severity = "warning"

    if snapshot.disk_percent is not None:
        if snapshot.disk_percent > _CRITICAL_DISK:
            reasons.append(f"Disk critical: {snapshot.disk_percent:.1f}%")
            severity = "critical"
        elif snapshot.disk_percent > _WARNING_DISK:
            reasons.append(f"Disk elevated: {snapshot.disk_percent:.1f}%")
            if severity == "healthy":
                severity = "warning"

    return severity, reasons


class DeviceTelemetryService:
    def __init__(self, db):
        self.db = db
        self.repo = DeviceTelemetryRepository(db)
        self.score_service = DeviceHealthScoreService(db)

    def create_snapshot(
        self,
        device_id: int,
        cpu_percent: Optional[float] = None,
        ram_percent: Optional[float] = None,
        disk_percent: Optional[float] = None,
        uptime_seconds: Optional[int] = None,
        heartbeat_latency_ms: Optional[int] = None,
    ) -> Tuple[DeviceTelemetry, str, str, List[str]]:
        prev = self.repo.get_latest(device_id)
        prev_state, _ = compute_health("online", prev)

        snapshot = self.repo.create(
            device_id=device_id,
            cpu_percent=cpu_percent,
            ram_percent=ram_percent,
            disk_percent=disk_percent,
            uptime_seconds=uptime_seconds,
            heartbeat_latency_ms=heartbeat_latency_ms,
        )
        new_state, reasons = compute_health("online", snapshot)
        return snapshot, prev_state, new_state, reasons

    def get_health(self, device) -> DeviceHealth:
        snapshot = self.repo.get_latest(device.id)
        score, state, reasons = self.score_service.compute_for_device(device, snapshot)
        return DeviceHealth(
            device_id=device.id,
            health_score=score,
            health_state=state,
            latest_telemetry=TelemetrySnapshot.model_validate(snapshot) if snapshot else None,
            reasons=reasons,
        )

    def get_latest(self, device_id: int) -> Optional[TelemetrySnapshot]:
        snapshot = self.repo.get_latest(device_id)
        return TelemetrySnapshot.model_validate(snapshot) if snapshot else None

    def get_history(self, device_id: int, limit: int = 20) -> List[TelemetrySnapshot]:
        return [TelemetrySnapshot.model_validate(s) for s in self.repo.get_recent_by_device(device_id, limit=limit)]

    def get_health_summary_all(self, devices: list) -> List[DeviceHealthSummary]:
        all_latest = self.repo.get_latest_all()
        latest_by_device = {t.device_id: t for t in all_latest}
        scores = self.score_service.compute_for_devices(devices)
        result = []
        for device in devices:
            snapshot = latest_by_device.get(device.id)
            score, state, _ = scores.get(device.id, (100, "healthy", []))
            result.append(
                DeviceHealthSummary(
                    device_id=device.id,
                    health_score=score,
                    health_state=state,
                    cpu_percent=snapshot.cpu_percent if snapshot else None,
                    ram_percent=snapshot.ram_percent if snapshot else None,
                    disk_percent=snapshot.disk_percent if snapshot else None,
                    uptime_seconds=snapshot.uptime_seconds if snapshot else None,
                    heartbeat_latency_ms=snapshot.heartbeat_latency_ms if snapshot else None,
                    computed_at=snapshot.created_at if snapshot else None,
                )
            )
        return result
