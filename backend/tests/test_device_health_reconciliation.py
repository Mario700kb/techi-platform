import json
from types import SimpleNamespace

from app.models.device import DeviceStatus
from app.services.device_health_score_service import compute_device_health_score
from app.services.device_heartbeat_service import DeviceHeartbeatService


def _device(**overrides):
    values = {
        "id": 12,
        "last_seen": None,
        "freshness_state": "online",
        "platform": "windows",
        "capabilities": None,
        "remote_support_state": "installed_running",
        "rustdesk_install_status": "installed",
        "rustdesk_status": "running",
        "current_user": "TECHI\\operator",
        "duplicate_candidate": False,
        "is_archived": False,
        "is_in_maintenance": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _telemetry(*, disk=30.0):
    return SimpleNamespace(cpu_percent=10.0, ram_percent=20.0, disk_percent=disk)


def _inventory(pending=0, reboot_required=False):
    return SimpleNamespace(
        patch_json=json.dumps({"pending_updates": pending, "reboot_required": reboot_required}),
        collected_at=None,
    )


def test_pending_updates_alone_do_not_degrade_current_healthy_device():
    score, state, reasons = compute_device_health_score(
        _device(), _telemetry(), {}, _inventory(pending=5),
    )
    assert score == 86
    assert state == "healthy"
    assert reasons == ["5 patch(es) pending"]


def test_disk_warning_uses_same_threshold_as_alert_engine():
    score, state, reasons = compute_device_health_score(
        _device(), _telemetry(disk=93.2), {"warning": 1}, _inventory(pending=5),
    )
    assert score == 66
    assert state == "warning"
    assert "Disk elevated: 93.2%" in reasons
    assert not any("Disk critical" in reason for reason in reasons)


def test_active_critical_alert_still_degrades_device():
    score, state, reasons = compute_device_health_score(
        _device(), _telemetry(disk=93.2), {"critical": 1, "warning": 1}, _inventory(pending=5),
    )
    assert score == 48
    assert state == "critical"
    assert "1 critical alert(s) open" in reasons


def test_current_heartbeat_side_effects_resolve_stale_offline_alert(monkeypatch):
    resolved = []
    engine = SimpleNamespace(
        resolve_device_offline=lambda device: resolved.append(device.id),
        evaluate_archived_checkin=lambda device: None,
        evaluate_rustdesk_sync=lambda device: None,
        evaluate_reconnect=lambda device, count: None,
    )
    monkeypatch.setattr("app.services.device_heartbeat_service.AlertEngine", lambda db: engine)
    monkeypatch.setattr(
        "app.repositories.device_status_history_repository.DeviceStatusHistoryRepository.count_recent_online_transitions",
        lambda *args, **kwargs: 0,
    )
    service = DeviceHeartbeatService.__new__(DeviceHeartbeatService)
    service.db = None
    device = _device(status=DeviceStatus.ONLINE, platform="windows")

    service._evaluate_post_heartbeat_alerts(device)

    assert resolved == [device.id]
