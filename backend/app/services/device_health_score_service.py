from datetime import datetime
from typing import Dict, List, Optional, Tuple

from app.models.alert import AlertSeverity
from app.models.device import Device
from app.models.device_telemetry import DeviceTelemetry
from app.repositories.alert_repository import AlertRepository
from app.repositories.device_telemetry_repository import DeviceTelemetryRepository


class DeviceHealthScoreService:
    def __init__(self, db):
        self.telemetry_repo = DeviceTelemetryRepository(db)
        self.alert_repo = AlertRepository(db)

    def compute_for_device(
        self,
        device: Device,
        snapshot: Optional[DeviceTelemetry] = None,
        alert_counts: Optional[Dict[str, int]] = None,
    ) -> Tuple[int, str, List[str]]:
        if snapshot is None:
            snapshot = self.telemetry_repo.get_latest(device.id)
        if alert_counts is None:
            alert_counts = self.alert_repo.count_open_by_device_and_severity([device.id]).get(device.id, {})
        return compute_device_health_score(device, snapshot, alert_counts)

    def compute_for_devices(self, devices: List[Device]) -> Dict[int, Tuple[int, str, List[str]]]:
        latest_by_device = {t.device_id: t for t in self.telemetry_repo.get_latest_all()}
        alert_counts = self.alert_repo.count_open_by_device_and_severity([device.id for device in devices])
        return {
            device.id: compute_device_health_score(
                device,
                latest_by_device.get(device.id),
                alert_counts.get(device.id, {}),
            )
            for device in devices
        }


def compute_device_health_score(
    device: Device,
    snapshot: Optional[DeviceTelemetry],
    alert_counts: Dict[str, int],
) -> Tuple[int, str, List[str]]:
    penalties: List[Tuple[float, str]] = []

    _add_telemetry_penalties(penalties, snapshot)
    _add_freshness_penalties(penalties, device)
    _add_inventory_trust_penalties(penalties, device)
    _add_alert_penalties(penalties, alert_counts)

    multiplier = 0.45 if getattr(device, "is_in_maintenance", False) else 1.0
    penalty_total = sum(value * multiplier for value, _ in penalties)
    score = _clamp(round(100 - penalty_total), 0, 100)
    state = _state_from_score(score)
    reasons = [reason for _, reason in penalties[:6]]

    if getattr(device, "is_in_maintenance", False) and penalties:
        reasons.append("Maintenance mode reduces active penalties")

    return score, state, reasons


def _add_telemetry_penalties(penalties: List[Tuple[float, str]], snapshot: Optional[DeviceTelemetry]) -> None:
    if snapshot is None:
        return

    for label, value, warning, critical, warning_penalty, critical_penalty in [
        ("CPU", snapshot.cpu_percent, 75.0, 90.0, 10.0, 22.0),
        ("RAM", snapshot.ram_percent, 80.0, 90.0, 10.0, 22.0),
        ("Disk", snapshot.disk_percent, 85.0, 95.0, 12.0, 24.0),
    ]:
        if value is None:
            continue
        if value >= critical:
            penalties.append((critical_penalty, f"{label} critical: {value:.1f}%"))
        elif value >= warning:
            penalties.append((warning_penalty, f"{label} elevated: {value:.1f}%"))


def _add_freshness_penalties(penalties: List[Tuple[float, str]], device: Device) -> None:
    freshness = getattr(device, "freshness_state", "offline")
    if freshness == "online":
        return
    if freshness == "stale":
        penalties.append((12.0, "Heartbeat is stale"))
        return

    if not device.last_seen:
        penalties.append((45.0, "Device has never checked in"))
        return

    age_hours = max((datetime.utcnow() - device.last_seen).total_seconds() / 3600, 0)
    if age_hours >= 24 * 7:
        penalties.append((45.0, "Device offline for more than 7 days"))
    elif age_hours >= 24:
        penalties.append((35.0, "Device offline for more than 24 hours"))
    else:
        penalties.append((25.0, "Device is offline"))


def _add_inventory_trust_penalties(penalties: List[Tuple[float, str]], device: Device) -> None:
    if getattr(device, "duplicate_candidate", False):
        penalties.append((7.0, "Possible duplicate device"))
    if getattr(device, "is_archived", False) and getattr(device, "freshness_state", "offline") != "offline":
        penalties.append((18.0, "Archived device is checking in"))


def _add_alert_penalties(penalties: List[Tuple[float, str]], alert_counts: Dict[str, int]) -> None:
    critical = int(alert_counts.get(AlertSeverity.CRITICAL.value, 0))
    warning = int(alert_counts.get(AlertSeverity.WARNING.value, 0))
    if critical:
        penalties.append((min(critical * 18.0, 36.0), f"{critical} critical alert(s) open"))
    if warning:
        penalties.append((min(warning * 8.0, 24.0), f"{warning} warning alert(s) open"))


def _state_from_score(score: int) -> str:
    if score < 50:
        return "critical"
    if score < 80:
        return "warning"
    return "healthy"


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))
