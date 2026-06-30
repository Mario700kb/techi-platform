from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.device_heartbeat_service import DeviceHeartbeatService


def _service_with_recent_event(recent_event):
    svc = DeviceHeartbeatService.__new__(DeviceHeartbeatService)
    svc.db = MagicMock()
    svc.db.query.return_value.filter.return_value.first.return_value = recent_event
    return svc


def test_rustdesk_repair_event_is_recorded_when_no_recent_event():
    svc = _service_with_recent_event(None)
    device = SimpleNamespace(id=42, rustdesk_repair_count=7)

    with patch("app.services.device_heartbeat_service.DeviceActivityEventService") as activity:
        svc._maybe_emit_rustdesk_repaired(device, previous_count=6)

    activity.return_value.record.assert_called_once()


def test_rustdesk_repair_event_is_throttled_when_recent_event_exists():
    svc = _service_with_recent_event(object())
    device = SimpleNamespace(id=42, rustdesk_repair_count=7)

    with patch("app.services.device_heartbeat_service.DeviceActivityEventService") as activity:
        svc._maybe_emit_rustdesk_repaired(device, previous_count=6)

    activity.return_value.record.assert_not_called()
