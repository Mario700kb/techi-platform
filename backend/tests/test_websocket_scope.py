"""
Regression tests for WebSocket scope filtering.

Verifies that RealtimeConnectionManager._event_in_scope correctly:
- Allows all events for unrestricted connections (admin/owner scope=None).
- Allows device events only when the device is within the operator's AllowedScope.
- Blocks device events for out-of-scope devices (different client/group/device).
- Always allows non-device events (connection_ready, deployment_event, etc.).
"""

import asyncio

import pytest

from app.core.scope import AllowedScope, device_in_scope
from app.websocket.manager import RealtimeConnectionManager
from app.websocket.routes import _AUTH_FAILED, _authenticate_ws


# ── Helper — build minimal device event dict ─────────────────────────────── #

def _device_event(event_type: str, *, device_id: int, client_id=None, group_id=None):
    return {
        "type": event_type,
        "tenant_id": "default",
        "data": {
            "id": device_id,
            "client_id": client_id,
            "group_id": group_id,
            "rustdesk_id": f"RUST-{device_id:04d}",
            "hostname": f"host-{device_id}",
        },
    }


def _non_device_event(event_type: str):
    return {"type": event_type, "tenant_id": "default", "data": {}}


# ── Instantiate manager (no async needed for unit tests) ─────────────────── #

mgr = RealtimeConnectionManager()


def test_missing_token_is_closed_with_application_code():
    class FakeWebSocket:
        accepted = False
        close_code = None

        async def accept(self):
            self.accepted = True

        async def close(self, code):
            self.close_code = code

    websocket = FakeWebSocket()
    result = asyncio.run(_authenticate_ws(websocket, None))

    assert result is _AUTH_FAILED
    assert websocket.accepted is True
    assert websocket.close_code == 4001


# ── Unrestricted scope (admin/owner) ─────────────────────────────────────── #

class TestUnrestrictedScope:
    def test_unrestricted_allows_any_device_event(self):
        event = _device_event("heartbeat_received", device_id=1, client_id=99)
        assert mgr._event_in_scope(event, scope=None) is True

    def test_unrestricted_allows_non_device_event(self):
        assert mgr._event_in_scope(_non_device_event("deployment_event"), scope=None) is True

    def test_unrestricted_allows_connection_ready(self):
        assert mgr._event_in_scope(_non_device_event("connection_ready"), scope=None) is True


# ── Restricted scope (operator/readonly) ─────────────────────────────────── #

class TestRestrictedScopeByClient:
    """Operator has access to client_id=1 only."""

    def setup_method(self):
        self.scope = AllowedScope(client_ids=frozenset({1}))

    def test_in_scope_client_device_allowed(self):
        event = _device_event("heartbeat_received", device_id=10, client_id=1)
        assert mgr._event_in_scope(event, self.scope) is True

    def test_out_of_scope_client_device_blocked(self):
        event = _device_event("heartbeat_received", device_id=20, client_id=2)
        assert mgr._event_in_scope(event, self.scope) is False

    def test_out_of_scope_rustdesk_id_not_sent(self):
        """rustdesk_id in payload must not reach the operator for out-of-scope devices."""
        event = _device_event("device_online", device_id=30, client_id=2)
        assert mgr._event_in_scope(event, self.scope) is False

    def test_device_online_in_scope_allowed(self):
        event = _device_event("device_online", device_id=11, client_id=1)
        assert mgr._event_in_scope(event, self.scope) is True

    def test_device_offline_out_of_scope_blocked(self):
        event = _device_event("device_offline", device_id=21, client_id=2)
        assert mgr._event_in_scope(event, self.scope) is False

    def test_device_updated_out_of_scope_blocked(self):
        event = _device_event("device_updated", device_id=22, client_id=2)
        assert mgr._event_in_scope(event, self.scope) is False

    def test_rustdesk_updated_out_of_scope_blocked(self):
        event = _device_event("rustdesk_updated", device_id=23, client_id=2)
        assert mgr._event_in_scope(event, self.scope) is False


class TestRestrictedScopeByGroup:
    """Operator has access to group_id=5 only (no client-level access)."""

    def setup_method(self):
        self.scope = AllowedScope(group_ids=frozenset({5}))

    def test_in_scope_group_device_allowed(self):
        event = _device_event("heartbeat_received", device_id=50, client_id=2, group_id=5)
        assert mgr._event_in_scope(event, self.scope) is True

    def test_different_group_blocked(self):
        event = _device_event("heartbeat_received", device_id=60, client_id=2, group_id=6)
        assert mgr._event_in_scope(event, self.scope) is False


class TestRestrictedScopeByDeviceId:
    """Operator has explicit device-level access only."""

    def setup_method(self):
        self.scope = AllowedScope(device_ids=frozenset({42}))

    def test_explicit_device_allowed(self):
        event = _device_event("heartbeat_received", device_id=42, client_id=3)
        assert mgr._event_in_scope(event, self.scope) is True

    def test_other_device_from_same_client_blocked(self):
        event = _device_event("heartbeat_received", device_id=43, client_id=3)
        assert mgr._event_in_scope(event, self.scope) is False


class TestEmptyScope:
    """Operator with no team access sees nothing."""

    def setup_method(self):
        self.scope = AllowedScope()  # empty frozensets

    def test_no_device_event_passes(self):
        event = _device_event("heartbeat_received", device_id=1, client_id=1)
        assert mgr._event_in_scope(event, self.scope) is False

    def test_non_device_event_still_passes(self):
        # Non-device events (no id/client_id/group_id) are always forwarded.
        assert mgr._event_in_scope(_non_device_event("server_ping"), self.scope) is True


class TestNonDeviceEvents:
    """Events without device-identifying fields reach all authenticated users."""

    def setup_method(self):
        self.scope = AllowedScope(client_ids=frozenset({1}))

    def test_deployment_event_passes(self):
        assert mgr._event_in_scope(_non_device_event("deployment_event"), self.scope) is True

    def test_server_ping_passes(self):
        assert mgr._event_in_scope(_non_device_event("server_ping"), self.scope) is True

    def test_connection_ready_passes(self):
        assert mgr._event_in_scope(_non_device_event("connection_ready"), self.scope) is True

    def test_event_with_no_data_passes(self):
        event = {"type": "server_ping", "tenant_id": "default"}
        assert mgr._event_in_scope(event, self.scope) is True


class TestMultiClientScope:
    """Operator has access to two clients."""

    def setup_method(self):
        self.scope = AllowedScope(client_ids=frozenset({1, 3}))

    def test_client_1_allowed(self):
        assert mgr._event_in_scope(
            _device_event("heartbeat_received", device_id=10, client_id=1), self.scope
        ) is True

    def test_client_3_allowed(self):
        assert mgr._event_in_scope(
            _device_event("heartbeat_received", device_id=30, client_id=3), self.scope
        ) is True

    def test_client_2_blocked(self):
        assert mgr._event_in_scope(
            _device_event("heartbeat_received", device_id=20, client_id=2), self.scope
        ) is False
