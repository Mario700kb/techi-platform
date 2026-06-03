"""
Tests for RustDeskIdentityService.apply_heartbeat_sync change detection.

Verifies that RUSTDESK_UPDATED is emitted only when rustdesk_id, version,
install_path, or sync_state actually changes — not on every heartbeat.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.rustdesk_service import RustDeskIdentityService
from app.websocket.events import RealtimeEventType


def _make_device(**kwargs):
    defaults = dict(
        id=1,
        rustdesk_id="123456",
        rustdesk_status="running",
        rustdesk_install_status="installed",
        rustdesk_version="1.2.3",
        rustdesk_install_path="C:\\RustDesk",
        rustdesk_sync_state="synced",
        rustdesk_sync_message=None,
        rustdesk_conflict_detected=False,
        rustdesk_manual_override=False,
        rustdesk_last_seen_at=None,
        rustdesk_synced_at=None,
        rustdesk_verified_at=None,
        rustdesk_repair_count=0,
    )
    defaults.update(kwargs)
    device = SimpleNamespace(**defaults)
    return device


def _make_service(device):
    """Return a RustDeskIdentityService with a mock DB and device_repo."""
    db = MagicMock()
    db.add = MagicMock()
    db.commit = MagicMock()
    db.refresh = MagicMock()

    svc = RustDeskIdentityService.__new__(RustDeskIdentityService)
    svc.db = db
    svc.device_repo = MagicMock()
    svc.device_repo.get_conflicting_rustdesk_id.return_value = None
    return svc


class TestRustdeskHeartbeatSyncNoSpam:
    """RUSTDESK_UPDATED must NOT fire when nothing changed."""

    def test_no_event_when_everything_identical(self):
        device = _make_device()
        svc = _make_service(device)

        with patch.object(RustDeskIdentityService, "_publish") as mock_pub:
            svc.apply_heartbeat_sync(
                device,
                reported_rustdesk_id="123456",
                install_status="installed",
                rustdesk_status="running",
                version="1.2.3",
                install_path="C:\\RustDesk",
            )
            # sync_state stays "synced", rustdesk_id/version/install_path unchanged
            rustdesk_updated_calls = [
                c for c in mock_pub.call_args_list
                if c.args and c.args[0] == RealtimeEventType.RUSTDESK_UPDATED
            ]
            assert rustdesk_updated_calls == [], (
                "RUSTDESK_UPDATED must NOT fire when no metadata changed"
            )

    def test_no_event_on_repeated_heartbeats_same_data(self):
        device = _make_device()
        svc = _make_service(device)

        with patch.object(RustDeskIdentityService, "_publish") as mock_pub:
            for _ in range(5):
                svc.apply_heartbeat_sync(
                    device,
                    reported_rustdesk_id="123456",
                    install_status="installed",
                    rustdesk_status="running",
                    version="1.2.3",
                    install_path="C:\\RustDesk",
                )
            rustdesk_updated_calls = [
                c for c in mock_pub.call_args_list
                if c.args and c.args[0] == RealtimeEventType.RUSTDESK_UPDATED
            ]
            assert rustdesk_updated_calls == []


class TestRustdeskHeartbeatSyncFiresOnChange:
    """RUSTDESK_UPDATED MUST fire when a meaningful field changes."""

    def test_fires_when_rustdesk_id_changes(self):
        device = _make_device(rustdesk_id="old_id")
        svc = _make_service(device)

        with patch.object(RustDeskIdentityService, "_publish") as mock_pub:
            svc.apply_heartbeat_sync(
                device,
                reported_rustdesk_id="new_id",
                install_status="installed",
                rustdesk_status="running",
                version="1.2.3",
                install_path="C:\\RustDesk",
            )
            rustdesk_updated_calls = [
                c for c in mock_pub.call_args_list
                if c.args and c.args[0] == RealtimeEventType.RUSTDESK_UPDATED
            ]
            assert len(rustdesk_updated_calls) == 1

    def test_fires_when_version_changes(self):
        device = _make_device(rustdesk_version="1.0.0")
        svc = _make_service(device)

        with patch.object(RustDeskIdentityService, "_publish") as mock_pub:
            svc.apply_heartbeat_sync(
                device,
                reported_rustdesk_id="123456",
                install_status="installed",
                rustdesk_status="running",
                version="1.2.3",       # changed
                install_path="C:\\RustDesk",
            )
            rustdesk_updated_calls = [
                c for c in mock_pub.call_args_list
                if c.args and c.args[0] == RealtimeEventType.RUSTDESK_UPDATED
            ]
            assert len(rustdesk_updated_calls) == 1

    def test_fires_when_install_path_changes(self):
        device = _make_device(rustdesk_install_path="C:\\Old")
        svc = _make_service(device)

        with patch.object(RustDeskIdentityService, "_publish") as mock_pub:
            svc.apply_heartbeat_sync(
                device,
                reported_rustdesk_id="123456",
                install_status="installed",
                rustdesk_status="running",
                version="1.2.3",
                install_path="C:\\New",   # changed
            )
            rustdesk_updated_calls = [
                c for c in mock_pub.call_args_list
                if c.args and c.args[0] == RealtimeEventType.RUSTDESK_UPDATED
            ]
            assert len(rustdesk_updated_calls) == 1

    def test_fires_when_sync_state_recovers_from_failed(self):
        device = _make_device(rustdesk_sync_state="failed")
        svc = _make_service(device)

        with patch.object(RustDeskIdentityService, "_publish") as mock_pub:
            svc.apply_heartbeat_sync(
                device,
                reported_rustdesk_id="123456",
                install_status="installed",
                rustdesk_status="running",
                version="1.2.3",
                install_path="C:\\RustDesk",
            )
            rustdesk_updated_calls = [
                c for c in mock_pub.call_args_list
                if c.args and c.args[0] == RealtimeEventType.RUSTDESK_UPDATED
            ]
            assert len(rustdesk_updated_calls) == 1, (
                "RUSTDESK_UPDATED must fire when sync_state transitions from failed → synced"
            )
