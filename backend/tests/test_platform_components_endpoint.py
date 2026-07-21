"""GET /platform/components — read-only registry metadata endpoint.

Verifies stable-string output, auth requirement, deterministic shape, and that
the exposed lifecycle handlers are real existing actions. No DB involved.
"""
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import platform as platform_endpoint
from app.core.auth import get_current_operator
from app.platform_core.actions import ACTION_REGISTRY
from app.schemas.agent_package import AgentFileType


def _client(authed: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(platform_endpoint.router, prefix="/platform")
    if authed:
        app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(
            id=1, username="m", role="operator"
        )
    return TestClient(app, raise_server_exceptions=True)


def test_requires_auth():
    resp = _client(authed=False).get("/platform/components")
    assert resp.status_code in (401, 403)


def test_returns_versioned_component_metadata():
    resp = _client().get("/platform/components")
    assert resp.status_code == 200
    body = resp.json()
    assert body["schema_version"] == 1
    by_id = {c["id"]: c for c in body["components"]}
    assert set(by_id) == {"agent", "remote_support"}

    agent = by_id["agent"]
    assert agent["display_name"] == "TECHI Agent"
    assert set(agent["file_types"]) == {"msi", "agent_binary", "agent_update_msi"}
    assert agent["platforms"] == ["windows", "linux"]
    assert agent["capabilities"] == []
    assert agent["icon_key"] == "agent"

    rs = by_id["remote_support"]
    assert set(rs["file_types"]) == {
        "remote_support_msi", "remote_support_bundle",
        "remote_support_dmg", "remote_support_pkg",
    }
    assert rs["capabilities"] == ["remote_support"]

    # Deployment policy metadata (Phase 5) — present, stable strings.
    for component in (agent, rs):
        pol = component["policy"]
        assert pol["desired_source"] == "active_package"
        assert pol["policy"] == "active_package"
        assert pol["strategy"] == "manual"


def test_every_file_type_present_across_components():
    body = _client().get("/platform/components").json()
    seen = {ft for c in body["components"] for ft in c["file_types"]}
    assert seen == {ft.value for ft in AgentFileType}


def test_lifecycle_exposes_stable_strings_and_real_actions():
    body = _client().get("/platform/components").json()
    rs = next(c for c in body["components"] if c["id"] == "remote_support")
    ops = {item["operation"]: item["action_type"] for item in rs["lifecycle"]}
    assert ops["install"] == "deploy_remote_support"
    assert ops["reinstall"] == "reinstall_rustdesk"
    assert ops["repair"] == "repair_config_rustdesk"
    assert ops["sync"] == "sync_rustdesk"
    # discover is a supported operation with no queued action (heartbeat).
    assert ops["discover"] is None
    # Every non-null action_type is a real registered action.
    for c in body["components"]:
        for item in c["lifecycle"]:
            if item["action_type"] is not None:
                assert item["action_type"] in ACTION_REGISTRY


def test_lifecycle_entries_carry_label_and_kind():
    body = _client().get("/platform/components").json()
    for c in body["components"]:
        for item in c["lifecycle"]:
            assert item["label"] and isinstance(item["label"], str)
            # kind reflects whether a queued action backs the operation.
            expected = "action" if item["action_type"] is not None else "out_of_band"
            assert item["kind"] == expected
    rs = next(c for c in body["components"] if c["id"] == "remote_support")
    labels = {item["operation"]: item["label"] for item in rs["lifecycle"]}
    assert labels["reinstall"] == "Reinstall"
    kinds = {item["operation"]: item["kind"] for item in rs["lifecycle"]}
    assert kinds["install"] == "action" and kinds["discover"] == "out_of_band"


def test_agent_lifecycle_shape():
    body = _client().get("/platform/components").json()
    agent = next(c for c in body["components"] if c["id"] == "agent")
    ops = {item["operation"]: item["action_type"] for item in agent["lifecycle"]}
    assert ops["update"] == "self_update"
    assert ops["restart"] == "restart_agent"
    assert ops["install"] is None  # GPO/NETLOGON
    assert "sync" not in ops and "repair" not in ops
