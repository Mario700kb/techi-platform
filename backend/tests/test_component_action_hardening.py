"""Production Hardening (Operational M14): auth, audit trail, idempotency/
concurrency guard, and least-privilege on the Component Action surface.
"""
import json
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
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import OperatorRole


def _make_db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=7, hostname="win-1", platform="windows", capabilities=None,
        device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE,
    ))
    db.commit()
    return db


def _authed_client(db, role=OperatorRole.ADMIN.value):
    app = FastAPI()
    app.include_router(endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=role)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app)


def _unauthed_client(db):
    # No get_current_operator override → real auth dependency runs (401 w/o token).
    app = FastAPI()
    app.include_router(endpoint.router)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app, raise_server_exceptions=True)


# --------------------------------------------------------------------------- #
# Auth — every surface requires authentication                                #
# --------------------------------------------------------------------------- #
def test_read_endpoint_requires_auth():
    r = _unauthed_client(_make_db()).get("/devices/7/components/telemetry")
    assert r.status_code in (401, 403)


def test_write_endpoint_requires_auth():
    r = _unauthed_client(_make_db()).post(
        "/devices/7/components/agent/actions", json={"operation": "update"}
    )
    assert r.status_code in (401, 403)


def test_bulk_endpoint_requires_auth():
    r = _unauthed_client(_make_db()).post(
        "/components/actions/bulk",
        json={"device_ids": [7], "targets": [{"component_id": "agent", "operation": "update"}]},
    )
    assert r.status_code in (401, 403)


# --------------------------------------------------------------------------- #
# Audit trail                                                                  #
# --------------------------------------------------------------------------- #
def test_single_action_is_audited():
    db = _make_db()
    r = _authed_client(db).post("/devices/7/components/agent/actions", json={"operation": "update"})
    assert r.status_code == 200
    rows = db.query(AuditLog).filter(AuditLog.action == "action_queued").all()
    assert len(rows) == 1
    details = json.loads(rows[0].details_json)
    assert details["component_id"] == "agent" and details["operation"] == "update"


def test_bulk_is_audited_with_summary():
    db = _make_db()
    r = _authed_client(db).post(
        "/components/actions/bulk",
        json={"device_ids": [7], "targets": [{"component_id": "agent", "operation": "update"}]},
    )
    assert r.status_code == 200
    rows = db.query(AuditLog).filter(AuditLog.action == "action_queued").all()
    assert len(rows) == 1
    details = json.loads(rows[0].details_json)
    assert details["bulk"] is True and details["succeeded"] == 1


# --------------------------------------------------------------------------- #
# Idempotency / concurrency guard (no duplicate actions)                      #
# --------------------------------------------------------------------------- #
def test_duplicate_is_blocked_and_not_double_queued():
    db = _make_db()
    client = _authed_client(db)
    assert client.post("/devices/7/components/agent/actions", json={"operation": "update"}).status_code == 200
    dup = client.post("/devices/7/components/agent/actions", json={"operation": "update"})
    assert dup.status_code == 409
    from app.models.remote_action import RemoteAction
    assert db.query(RemoteAction).count() == 1  # exactly one, never doubled


# --------------------------------------------------------------------------- #
# Least privilege — override honored only for elevated operators              #
# --------------------------------------------------------------------------- #
def test_override_requires_elevated_operator():
    # Security property the endpoints rely on:
    #   override = payload.override and is_unrestricted(operator)
    # so a non-elevated operator can never assert a policy override.
    from app.core.auth import is_unrestricted

    assert is_unrestricted(SimpleNamespace(role=OperatorRole.OWNER.value)) is True
    assert is_unrestricted(SimpleNamespace(role=OperatorRole.ADMIN.value)) is True
    assert is_unrestricted(SimpleNamespace(role=OperatorRole.OPERATOR.value)) is False
    assert is_unrestricted(SimpleNamespace(role=OperatorRole.READONLY.value)) is False
