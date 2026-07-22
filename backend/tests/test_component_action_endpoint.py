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
