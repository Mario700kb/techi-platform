"""POST /devices/{id}/components/{component}/actions — Component Action API
(Platform Components — Operational, Milestones 2/4).

One registry-driven endpoint: resolves a component lifecycle operation to an
EXISTING ActionType and queues it through the unchanged action pipeline. Verifies
happy-path queueing, structured error codes, device-availability gating, and the
conflict guard — all against a real (sqlite) DB.
"""
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import component_actions as endpoint
from app.core.auth import get_current_operator
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import OperatorRole
from app.models.remote_action import RemoteAction
from app.schemas.remote_action import ActionType, RemoteActionCreate
from app.services.remote_action_service import RemoteActionService


def _client(platform="windows", capabilities=None):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=7, hostname="win-1", platform=platform, capabilities=capabilities,
        device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE,
    ))
    db.commit()
    app = FastAPI()
    app.include_router(endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=OperatorRole.ADMIN.value)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def _post(client, component, operation, parameters=None, device=7):
    body = {"operation": operation}
    if parameters is not None:
        body["parameters"] = parameters
    return client.post(f"/devices/{device}/components/{component}/actions", json=body)


# --------------------------------------------------------------------------- #
# Happy path — resolves + queues through the existing pipeline                  #
# --------------------------------------------------------------------------- #
def test_agent_update_queues_self_update():
    client, db = _client()
    r = _post(client, "agent", "update")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["component_id"] == "agent"
    assert body["operation"] == "update"
    assert body["action_type"] == "self_update"
    assert body["label"] == "Update"
    assert body["action"]["action_type"] == "self_update"
    assert body["action"]["status"] == "queued"
    # A real RemoteAction row exists — the EXISTING pipeline, not a parallel one.
    rows = db.query(RemoteAction).filter(RemoteAction.device_id == 7).all()
    assert len(rows) == 1 and rows[0].action_type == "self_update"


def test_remote_support_repair_queues_repair_action():
    client, _ = _client(capabilities={"remote_support": ""})
    r = _post(client, "remote_support", "repair")
    assert r.status_code == 200, r.text
    assert r.json()["action_type"] == "repair_config_rustdesk"


def test_parameters_pass_through_to_queued_action():
    client, db = _client()
    r = _post(client, "agent", "update", parameters={"version": "2.1.6"})
    assert r.status_code == 200, r.text
    row = db.query(RemoteAction).filter(RemoteAction.device_id == 7).first()
    assert (row.payload_dict or {}).get("version") == "2.1.6"


# --------------------------------------------------------------------------- #
# Structured errors (stable code in the JSON body)                             #
# --------------------------------------------------------------------------- #
def test_unknown_component_404():
    client, _ = _client()
    r = _post(client, "nope", "update")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "unknown_component"


def test_unknown_operation_400():
    client, _ = _client()
    r = _post(client, "agent", "frobnicate")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unknown_operation"


def test_unsupported_operation_422():
    client, _ = _client()
    r = _post(client, "agent", "sync")  # agent doesn't declare sync
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unsupported_operation"


def test_out_of_band_operation_422_not_executable():
    client, _ = _client()
    r = _post(client, "agent", "install")  # GPO/NETLOGON, no queued action
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "not_executable"


def test_unavailable_for_device_when_capability_missing():
    # remote_support action on a device that reports capabilities WITHOUT
    # remote_support → not available for this device.
    client, _ = _client(capabilities={"terminal": ""})
    r = _post(client, "remote_support", "repair")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unavailable_for_device"


def test_device_not_found_404():
    client, _ = _client()
    r = _post(client, "agent", "update", device=999)
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# Conflict guard (reuses the existing queue's duplicate protection)            #
# --------------------------------------------------------------------------- #
def test_duplicate_action_conflicts_409():
    client, _ = _client()
    assert _post(client, "agent", "update").status_code == 200
    r = _post(client, "agent", "update")
    assert r.status_code == 409


# --------------------------------------------------------------------------- #
# History (Milestone 7)                                                        #
# --------------------------------------------------------------------------- #
def test_history_lists_component_actions_with_attribution():
    client, _ = _client(capabilities={"remote_support": ""})
    _post(client, "agent", "update")
    _post(client, "remote_support", "restart")

    r = client.get("/devices/7/components/actions")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["device_id"] == 7
    items = body["items"]
    assert len(items) == 2
    # Newest first; each item carries operation/component/user/timestamp/result.
    by_component = {it["component_id"]: it for it in items}
    assert by_component["agent"]["operation"] == "update"
    assert by_component["agent"]["action_type"] == "self_update"
    assert by_component["agent"]["label"] == "Update"
    assert by_component["agent"]["created_by"] == "mario"
    assert by_component["agent"]["created_at"]
    assert by_component["remote_support"]["operation"] == "restart"


def test_history_filters_by_component():
    client, _ = _client(capabilities={"remote_support": ""})
    _post(client, "agent", "update")
    _post(client, "remote_support", "restart")

    r = client.get("/devices/7/components/actions", params={"component_id": "agent"})
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1 and items[0]["component_id"] == "agent"


def test_history_empty_when_no_component_actions():
    client, _ = _client()
    r = client.get("/devices/7/components/actions")
    assert r.status_code == 200
    assert r.json()["items"] == []


# --------------------------------------------------------------------------- #
# Timeout handling (Milestone 8)                                              #
# --------------------------------------------------------------------------- #
def test_valid_timeout_is_applied_to_queued_action():
    client, _ = _client()
    r = client.post(
        "/devices/7/components/agent/actions",
        json={"operation": "update", "timeout_seconds": 120},
    )
    assert r.status_code == 200, r.text
    assert r.json()["action"]["execution_timeout_seconds"] == 120


def test_out_of_range_timeout_rejected_400():
    client, _ = _client()
    r = client.post(
        "/devices/7/components/agent/actions",
        json={"operation": "update", "timeout_seconds": 99999},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_timeout"


# --------------------------------------------------------------------------- #
# Retry & idempotency (Milestone 8)                                           #
# --------------------------------------------------------------------------- #
def test_retry_terminal_component_action_requeues():
    client, db = _client()
    first = _post(client, "agent", "update")
    action_id = first.json()["action"]["id"]
    # Drive it to a terminal (failed) state via the existing service.
    RemoteActionService(db).fail(action_id, error_message="boom")

    r = client.post(f"/devices/7/components/actions/{action_id}/retry")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["component_id"] == "agent"
    assert body["operation"] == "update"
    assert body["action"]["id"] != action_id  # a fresh action


def test_retry_non_terminal_action_conflicts_409():
    client, _ = _client()
    first = _post(client, "agent", "update")  # status queued (non-terminal)
    action_id = first.json()["action"]["id"]
    r = client.post(f"/devices/7/components/actions/{action_id}/retry")
    assert r.status_code == 409


def test_retry_non_component_action_422():
    client, db = _client()
    # A non-component action (ping) queued directly; not retryable here.
    ping = RemoteActionService(db).queue_action(
        7, RemoteActionCreate(action_type=ActionType.PING, created_by="mario")
    )
    r = client.post(f"/devices/7/components/actions/{ping.id}/retry")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "not_a_component_action"


def test_retry_missing_action_404():
    client, _ = _client()
    r = client.post("/devices/7/components/actions/9999/retry")
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# Policy enforcement (Milestone 10)                                           #
# --------------------------------------------------------------------------- #
def test_policy_denied_when_globally_disabled(monkeypatch):
    import app.services.component_policy_enforcement as pe
    monkeypatch.setattr(
        pe, "GLOBAL_COMPONENT_POLICY",
        pe.ComponentEnforcementPolicy(manual_operations_allowed=False),
    )
    client, _ = _client()
    r = _post(client, "agent", "update")
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "policy_denied"


def test_elevated_operator_override_bypasses_policy(monkeypatch):
    import app.services.component_policy_enforcement as pe
    monkeypatch.setattr(
        pe, "GLOBAL_COMPONENT_POLICY",
        pe.ComponentEnforcementPolicy(manual_operations_allowed=False),
    )
    client, _ = _client()  # admin operator → override honored
    r = client.post(
        "/devices/7/components/agent/actions",
        json={"operation": "update", "override": True},
    )
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- #
# Package status (Milestone 11)                                               #
# --------------------------------------------------------------------------- #
def test_package_status_endpoint_shape():
    client, _ = _client()
    r = client.get("/devices/7/components/agent/package")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["device_id"] == 7
    assert body["component_id"] == "agent"
    # No manifest in tests → versions None, not outdated (inert but well-formed).
    assert body["outdated"] is False
    assert set(body) >= {
        "installed_version", "desired_version", "available_version", "outdated",
    }
