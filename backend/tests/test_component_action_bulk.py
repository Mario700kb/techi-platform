"""POST /components/actions/bulk — Bulk component actions (Operational M9).

Multiple devices × multiple components, each queued independently through the
existing pipeline, with per-item validation and partial-failure reporting.
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


def _client(device_ids=(7, 8)):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    for did in device_ids:
        db.add(Device(
            id=did, hostname=f"win-{did}", platform="windows", capabilities=None,
            device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE,
        ))
    db.commit()
    app = FastAPI()
    app.include_router(endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=OperatorRole.ADMIN.value)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def _bulk(client, device_ids, targets, **extra):
    body = {"device_ids": list(device_ids),
            "targets": [{"component_id": c, "operation": o} for c, o in targets],
            **extra}
    return client.post("/components/actions/bulk", json=body)


def test_bulk_all_succeed_across_devices_and_components():
    client, db = _client()
    r = _bulk(client, [7, 8], [("agent", "update"), ("remote_support", "restart")])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 4
    assert body["succeeded"] == 4 and body["failed"] == 0
    # 4 real RemoteActions queued through the existing pipeline.
    assert db.query(RemoteAction).count() == 4


def test_bulk_partial_failure_reports_per_item():
    client, _ = _client()
    r = _bulk(
        client,
        [7, 999],  # 999 is missing/out of scope
        [("agent", "update"), ("agent", "sync")],  # sync unsupported on agent
    )
    assert r.status_code == 200, r.text
    body = r.json()
    by = {(i["device_id"], i["operation"]): i for i in body["items"]}
    assert by[(7, "update")]["ok"] is True
    assert by[(7, "sync")]["ok"] is False
    assert by[(7, "sync")]["error_code"] == "unsupported_operation"
    # Missing device → device_not_found for each of its targets, never leaked.
    assert by[(999, "update")]["error_code"] == "device_not_found"
    assert by[(999, "sync")]["error_code"] == "device_not_found"
    assert body["succeeded"] == 1 and body["failed"] == 3


def test_bulk_conflict_on_duplicate_is_partial():
    client, _ = _client()
    # Same op twice in one batch on the same device → the 2nd conflicts.
    r = _bulk(client, [7], [("agent", "update"), ("agent", "update")])
    body = r.json()
    oks = [i for i in body["items"] if i["ok"]]
    fails = [i for i in body["items"] if not i["ok"]]
    assert len(oks) == 1 and len(fails) == 1
    assert fails[0]["error_code"] == "conflict"


def test_bulk_requires_devices_and_targets():
    client, _ = _client()
    assert _bulk(client, [], [("agent", "update")]).status_code == 400
    assert _bulk(client, [7], []).status_code == 400


def test_bulk_size_limit_enforced():
    client, _ = _client()
    # 1001 device ids × 1 target > 1000 ceiling.
    r = _bulk(client, list(range(1, 1002)), [("agent", "update")])
    assert r.status_code == 400


def test_bulk_timeout_applied_to_each_item():
    client, db = _client()
    r = _bulk(client, [7], [("agent", "update")], timeout_seconds=120)
    assert r.status_code == 200, r.text
    action = db.query(RemoteAction).first()
    assert action.execution_timeout_seconds == 120
