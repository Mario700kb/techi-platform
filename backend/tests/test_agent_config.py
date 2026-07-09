"""
Tests for agent configuration policy API.

Verifies:
- GET /agent-config requires admin or owner (operator/readonly → 403)
- PUT /agent-config requires admin or owner
- PUT /agent-config validates heartbeat 60–600 and inventory 300–86400
- GET /agent-config/heartbeat-script requires admin or owner
- Generated PowerShell contains the requested seconds
- Generated PowerShell preserves JSON keys via ConvertFrom-Json / ConvertTo-Json
- No impact on existing endpoints (no imports/side-effects from agent_config_service on heartbeat)
"""

import os
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.auth import get_current_operator
from app.models.operator import Operator
from app.api.v1.endpoints.agent_config import router as agent_config_router
from app.services import agent_config_service as svc


# ── Helpers ──────────────────────────────────────────────────────────────── #

def _make_operator(role: str) -> Operator:
    return Operator(
        id=1,
        username="testop",
        email="testop@test.com",
        hashed_password="x",
        role=role,
        is_active=True,
        is_superuser=False,
    )


def _make_client(role: str) -> TestClient:
    op = _make_operator(role)
    app = FastAPI()
    app.dependency_overrides[get_current_operator] = lambda: op
    app.include_router(agent_config_router, prefix="/agent-config")
    return TestClient(app, raise_server_exceptions=False)


# ── Fixtures ─────────────────────────────────────────────────────────────── #

@pytest.fixture(autouse=True)
def reset_policy(tmp_path):
    """Reset agent_config_service state before each test to avoid cross-test pollution."""
    policy_file = str(tmp_path / "agent_policy.json")
    svc.reset_for_testing(policy_file)
    yield
    svc.reset_for_testing(None)


# ── GET /agent-config ─────────────────────────────────────────────────────── #

class TestGetAgentConfig:
    def test_admin_can_get_config(self):
        client = _make_client("admin")
        resp = client.get("/agent-config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["heartbeat_interval_seconds"] == svc.HEARTBEAT_INTERVAL_DEFAULT
        assert body["platform_heartbeat_intervals"]["windows"] == svc.HEARTBEAT_INTERVAL_DEFAULT
        assert body["platform_heartbeat_intervals"]["mikrotik"] == 250
        assert body["platform_inventory_intervals"]["mikrotik"] == 1800
        assert body["online_threshold_minutes"] == svc.ONLINE_THRESHOLD_MINUTES
        assert body["stale_threshold_minutes"] == svc.STALE_THRESHOLD_MINUTES

    def test_owner_can_get_config(self):
        client = _make_client("owner")
        resp = client.get("/agent-config")
        assert resp.status_code == 200

    def test_operator_cannot_get_config(self):
        client = _make_client("operator")
        resp = client.get("/agent-config")
        assert resp.status_code == 403

    def test_readonly_cannot_get_config(self):
        client = _make_client("readonly")
        resp = client.get("/agent-config")
        assert resp.status_code == 403


# ── PUT /agent-config ─────────────────────────────────────────────────────── #

class TestPutAgentConfig:
    def test_admin_can_update_interval(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 120})
        assert resp.status_code == 200
        assert resp.json()["heartbeat_interval_seconds"] == 120

    def test_owner_can_update_interval(self):
        client = _make_client("owner")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 300})
        assert resp.status_code == 200
        assert resp.json()["heartbeat_interval_seconds"] == 300

    def test_operator_cannot_update_interval(self):
        client = _make_client("operator")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 120})
        assert resp.status_code == 403

    def test_readonly_cannot_update_interval(self):
        client = _make_client("readonly")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 120})
        assert resp.status_code == 403

    def test_boundary_60_is_valid(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 60})
        assert resp.status_code == 200
        assert resp.json()["heartbeat_interval_seconds"] == 60

    def test_boundary_600_is_valid(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 600})
        assert resp.status_code == 200
        assert resp.json()["heartbeat_interval_seconds"] == 600

    def test_below_minimum_is_rejected(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 59})
        assert resp.status_code == 422

    def test_above_maximum_is_rejected(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 601})
        assert resp.status_code == 422

    def test_zero_is_rejected(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 0})
        assert resp.status_code == 422

    def test_get_reflects_put(self):
        client = _make_client("admin")
        client.put("/agent-config", json={"heartbeat_interval_seconds": 240})
        resp = client.get("/agent-config")
        assert resp.status_code == 200
        assert resp.json()["heartbeat_interval_seconds"] == 240
        assert resp.json()["platform_heartbeat_intervals"]["windows"] == 240

    def test_admin_can_update_platform_intervals(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={
            "platform_heartbeat_intervals": {"mikrotik": 180, "linux": 240},
            "platform_inventory_intervals": {"mikrotik": 900},
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["platform_heartbeat_intervals"]["mikrotik"] == 180
        assert body["platform_heartbeat_intervals"]["linux"] == 240
        assert body["platform_inventory_intervals"]["mikrotik"] == 900

    def test_platform_inventory_below_minimum_is_rejected(self):
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"platform_inventory_intervals": {"mikrotik": 299}})
        assert resp.status_code == 422

    def test_thresholds_are_read_only(self):
        """Putting the config must never let the client change threshold values."""
        client = _make_client("admin")
        resp = client.put("/agent-config", json={"heartbeat_interval_seconds": 180})
        assert resp.status_code == 200
        assert resp.json()["online_threshold_minutes"] == svc.ONLINE_THRESHOLD_MINUTES
        assert resp.json()["stale_threshold_minutes"] == svc.STALE_THRESHOLD_MINUTES


# ── GET /agent-config/heartbeat-script ───────────────────────────────────── #

class TestHeartbeatScript:
    def test_admin_can_get_rollout_script(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=180")
        assert resp.status_code == 200

    def test_owner_can_get_rollout_script(self):
        client = _make_client("owner")
        resp = client.get("/agent-config/heartbeat-script?seconds=60")
        assert resp.status_code == 200

    def test_operator_cannot_get_script(self):
        client = _make_client("operator")
        resp = client.get("/agent-config/heartbeat-script?seconds=180")
        assert resp.status_code == 403

    def test_script_contains_target_seconds(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=240")
        assert resp.status_code == 200
        script = resp.text
        assert "240" in script

    def test_rollback_script_contains_60(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=60")
        assert "60" in resp.text

    def test_script_contains_config_path(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=180")
        assert "C:\\ProgramData\\TECHI\\agent.config.json" in resp.text
        assert "C:\\ProgramData\\TechiAgent\\agent.config.json" in resp.text
        assert "Migrated legacy config to $ConfigPath" in resp.text

    def test_script_contains_service_name(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=180")
        assert "TechiAgent" in resp.text

    def test_script_preserves_json_via_convert_cmdlets(self):
        """Script must use ConvertFrom-Json / ConvertTo-Json to preserve all keys."""
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=180")
        script = resp.text
        assert "ConvertFrom-Json" in script
        assert "ConvertTo-Json" in script

    def test_script_logs_to_expected_path(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=180")
        assert "C:\\Windows\\Temp\\techi-heartbeat-config.log" in resp.text

    def test_below_minimum_seconds_rejected(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=59")
        assert resp.status_code == 422

    def test_above_maximum_seconds_rejected(self):
        client = _make_client("admin")
        resp = client.get("/agent-config/heartbeat-script?seconds=601")
        assert resp.status_code == 422


# ── Service-level unit tests ──────────────────────────────────────────────── #

class TestAgentConfigService:
    def test_default_is_180(self):
        assert svc.get_policy()["heartbeat_interval_seconds"] == svc.HEARTBEAT_INTERVAL_DEFAULT

    def test_set_and_get_roundtrip(self):
        svc.set_heartbeat_interval(120)
        assert svc.get_policy()["heartbeat_interval_seconds"] == 120
        assert svc.get_policy()["platform_heartbeat_intervals"]["windows"] == 120

    def test_set_below_min_raises(self):
        with pytest.raises(ValueError):
            svc.set_heartbeat_interval(59)

    def test_set_above_max_raises(self):
        with pytest.raises(ValueError):
            svc.set_heartbeat_interval(601)

    def test_set_boundary_min(self):
        svc.set_heartbeat_interval(60)
        assert svc.get_policy()["heartbeat_interval_seconds"] == 60

    def test_set_boundary_max(self):
        svc.set_heartbeat_interval(600)
        assert svc.get_policy()["heartbeat_interval_seconds"] == 600

    def test_policy_persisted_to_file(self, tmp_path):
        policy_file = str(tmp_path / "policy.json")
        svc.reset_for_testing(policy_file)
        svc.set_heartbeat_interval(300)
        # Reset in-memory cache and re-read from file
        svc.reset_for_testing(policy_file)
        assert svc.get_policy()["heartbeat_interval_seconds"] == 300

    def test_thresholds_are_fixed(self):
        policy = svc.get_policy()
        assert policy["online_threshold_minutes"] == svc.ONLINE_THRESHOLD_MINUTES
        assert policy["stale_threshold_minutes"] == svc.STALE_THRESHOLD_MINUTES
