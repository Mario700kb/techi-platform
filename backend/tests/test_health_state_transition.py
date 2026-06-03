"""
Tests for health state transition logic in DeviceHeartbeatService._process_telemetry.

Verifies that:
1. prev_state and new_state are computed with the same DeviceHealthScoreService
   algorithm — not a mix of simple thresholds + scoring.
2. Health state change events are persisted as DeviceActivityEvent records so
   they survive a manual Refresh (live timeline == refreshed timeline).
3. No health event is emitted when state does not change.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from app.services.device_heartbeat_service import DeviceHeartbeatService


def _make_device(health_state="healthy"):
    return SimpleNamespace(
        id=42,
        status="online",
        freshness_state="online",
        rustdesk_install_status="installed",
        rustdesk_status="running",
        current_user="alice",
        is_in_maintenance=False,
        is_archived=False,
        duplicate_candidate=False,
        last_seen=None,
    )


def _make_service_instance():
    svc = DeviceHeartbeatService.__new__(DeviceHeartbeatService)
    svc.db = MagicMock()
    svc.heartbeat_repo = MagicMock()
    svc.heartbeat_repo.db = svc.db
    return svc


class TestHealthStatePrevNewConsistency:
    """prev_state and new_state must use the same algorithm."""

    def test_no_event_when_score_service_says_stable(self):
        """
        Previously: simple compute_health gave prev='healthy', but
        DeviceHealthScoreService gave new='warning' due to extra penalties —
        triggering a spurious HEALTH_WARNING.

        After fix: both states are computed by DeviceHealthScoreService,
        so if the score is consistently 'warning' nothing fires.
        """
        svc = _make_service_instance()
        device = _make_device()

        payload = SimpleNamespace(
            cpu_percent=78.0,
            ram_percent=60.0,
            disk_percent=50.0,
            uptime_seconds=None,
            heartbeat_latency_ms=None,
        )

        # Simulate: previous state = warning, current state = warning (no change)
        with (
            patch("app.services.device_heartbeat_service.DeviceTelemetryService") as MockTelSvc,
            patch("app.services.device_heartbeat_service.DeviceHealthScoreService") as MockScore,
            patch("app.services.device_heartbeat_service.AlertEngine"),
            patch("app.services.device_heartbeat_service.realtime_publisher"),
            patch("app.services.device_heartbeat_service.DeviceActivityEventService") as MockActivity,
        ):
            mock_snapshot = MagicMock()
            mock_prev_snapshot = MagicMock()

            mock_tel_instance = MockTelSvc.return_value
            mock_tel_instance.repo.get_latest.return_value = mock_prev_snapshot
            mock_tel_instance.create_snapshot.return_value = (mock_snapshot, "warning", "warning", [])

            mock_score_instance = MockScore.return_value
            # Both prev and new return the same state — no change
            mock_score_instance.compute_for_device.side_effect = [
                (72, "warning", ["CPU elevated"]),   # prev_state call
                (70, "warning", ["CPU elevated"]),   # new_state call
            ]

            svc._process_telemetry(payload, device)

            MockActivity.return_value.record.assert_not_called()

    def test_health_warning_emitted_and_persisted_on_real_transition(self):
        """When state genuinely goes healthy → warning, event fires AND is stored in DB."""
        svc = _make_service_instance()
        device = _make_device()

        payload = SimpleNamespace(
            cpu_percent=85.0,
            ram_percent=85.0,
            disk_percent=50.0,
            uptime_seconds=None,
            heartbeat_latency_ms=None,
        )

        with (
            patch("app.services.device_heartbeat_service.DeviceTelemetryService") as MockTelSvc,
            patch("app.services.device_heartbeat_service.DeviceHealthScoreService") as MockScore,
            patch("app.services.device_heartbeat_service.AlertEngine"),
            patch("app.services.device_heartbeat_service.realtime_publisher") as mock_pub,
            patch("app.services.device_heartbeat_service.DeviceActivityEventService") as MockActivity,
            patch("app.services.device_heartbeat_service.build_event", return_value={"type": "health_warning"}),
            patch("app.services.device_heartbeat_service.RealtimeEventType") as MockEventType,
        ):
            mock_snapshot = MagicMock()
            mock_prev_snapshot = MagicMock()

            mock_tel_instance = MockTelSvc.return_value
            mock_tel_instance.repo.get_latest.return_value = mock_prev_snapshot
            mock_tel_instance.create_snapshot.return_value = (mock_snapshot, "healthy", "warning", [])

            mock_score_instance = MockScore.return_value
            mock_score_instance.compute_for_device.side_effect = [
                (90, "healthy", []),                                   # prev_state
                (70, "warning", ["CPU elevated: 85.0%", "RAM elevated: 85.0%"]),  # new_state
            ]
            MockEventType.HEALTH_WARNING = "HEALTH_WARNING"
            MockEventType.TELEMETRY_UPDATED = "TELEMETRY_UPDATED"

            svc._process_telemetry(payload, device)

            # WebSocket event must be published
            mock_pub.publish_threadsafe.assert_called()

            # DeviceActivityEvent must be persisted
            MockActivity.return_value.record.assert_called_once()
            record_kwargs = MockActivity.return_value.record.call_args.kwargs
            assert record_kwargs["event_type"] == "health_warning"
            assert record_kwargs["device_id"] == device.id
            assert record_kwargs["actor"] == "system"

    def test_health_recovered_emitted_and_persisted(self):
        """When state goes warning → healthy, health_recovered is stored."""
        svc = _make_service_instance()
        device = _make_device()

        payload = SimpleNamespace(
            cpu_percent=50.0,
            ram_percent=50.0,
            disk_percent=40.0,
            uptime_seconds=None,
            heartbeat_latency_ms=None,
        )

        with (
            patch("app.services.device_heartbeat_service.DeviceTelemetryService") as MockTelSvc,
            patch("app.services.device_heartbeat_service.DeviceHealthScoreService") as MockScore,
            patch("app.services.device_heartbeat_service.AlertEngine"),
            patch("app.services.device_heartbeat_service.realtime_publisher"),
            patch("app.services.device_heartbeat_service.DeviceActivityEventService") as MockActivity,
            patch("app.services.device_heartbeat_service.build_event", return_value={}),
            patch("app.services.device_heartbeat_service.RealtimeEventType") as MockEventType,
        ):
            mock_snapshot = MagicMock()
            mock_prev_snapshot = MagicMock()

            mock_tel_instance = MockTelSvc.return_value
            mock_tel_instance.repo.get_latest.return_value = mock_prev_snapshot
            mock_tel_instance.create_snapshot.return_value = (mock_snapshot, "warning", "healthy", [])

            mock_score_instance = MockScore.return_value
            mock_score_instance.compute_for_device.side_effect = [
                (70, "warning", ["CPU elevated"]),  # prev_state
                (95, "healthy", []),                # new_state
            ]
            MockEventType.HEALTH_RECOVERED = "HEALTH_RECOVERED"
            MockEventType.TELEMETRY_UPDATED = "TELEMETRY_UPDATED"

            svc._process_telemetry(payload, device)

            MockActivity.return_value.record.assert_called_once()
            record_kwargs = MockActivity.return_value.record.call_args.kwargs
            assert record_kwargs["event_type"] == "health_recovered"

    def test_no_health_event_when_telemetry_absent(self):
        """_process_telemetry exits early when no telemetry fields are present."""
        svc = _make_service_instance()
        device = _make_device()

        payload = SimpleNamespace(
            cpu_percent=None,
            ram_percent=None,
            disk_percent=None,
            uptime_seconds=None,
            heartbeat_latency_ms=None,
        )

        with (
            patch("app.services.device_heartbeat_service.DeviceTelemetryService") as MockTelSvc,
            patch("app.services.device_heartbeat_service.DeviceActivityEventService") as MockActivity,
        ):
            svc._process_telemetry(payload, device)

            MockTelSvc.assert_not_called()
            MockActivity.return_value.record.assert_not_called()
