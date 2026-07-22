"""Component Action Telemetry (Operational M13): read-only aggregation over the
existing remote_actions store — counts, failures, success rate, duration, and
per-operation statistics, attributed to components.
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
from app.services.component_action_service import ComponentActionService
from app.services.component_telemetry_service import ComponentTelemetryService
from app.services.remote_action_service import RemoteActionService


def _db():
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


def _device(db):
    return db.query(Device).filter(Device.id == 7).first()


def _seed(db):
    svc = ComponentActionService(db)
    rsvc = RemoteActionService(db)
    # remote_support restart → succeeds (has duration).
    a1 = svc.execute(_device(db), "remote_support", "restart", created_by="m").action
    rsvc.mark_running(a1.id)
    rsvc.complete(a1.id, result_message="ok")
    # agent restart → fails.
    a2 = svc.execute(_device(db), "agent", "restart", created_by="m").action
    rsvc.fail(a2.id, error_message="boom")


def test_telemetry_aggregates_per_component_and_operation():
    db = _db()
    _seed(db)
    metrics = {m.component_id: m for m in ComponentTelemetryService(db).for_device(7)}

    rs = metrics["remote_support"]
    assert rs.total == 1 and rs.succeeded == 1 and rs.failed == 0
    assert rs.success_rate == 1.0
    assert rs.avg_duration_seconds is not None and rs.avg_duration_seconds >= 0
    assert rs.operations[0].operation == "restart" and rs.operations[0].succeeded == 1

    agent = metrics["agent"]
    assert agent.total == 1 and agent.failed == 1 and agent.succeeded == 0
    assert agent.success_rate == 0.0


def test_telemetry_ignores_non_component_actions():
    db = _db()
    from app.schemas.remote_action import ActionType, RemoteActionCreate
    RemoteActionService(db).queue_action(
        7, RemoteActionCreate(action_type=ActionType.PING, created_by="m")
    )
    metrics = ComponentTelemetryService(db).for_device(7)
    assert metrics == []  # ping is not attributable to a component


def test_telemetry_success_rate_none_when_all_in_progress():
    db = _db()
    ComponentActionService(db).execute(_device(db), "agent", "update", created_by="m")
    metrics = {m.component_id: m for m in ComponentTelemetryService(db).for_device(7)}
    agent = metrics["agent"]
    assert agent.in_progress == 1
    assert agent.success_rate is None  # no terminal succeeded/failed yet


# --------------------------------------------------------------------------- #
# Endpoint                                                                     #
# --------------------------------------------------------------------------- #
def _client(db):
    app = FastAPI()
    app.include_router(endpoint.router)
    operator = SimpleNamespace(id=1, username="m", role=OperatorRole.ADMIN.value)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app)


def test_telemetry_endpoint_shape():
    db = _db()
    _seed(db)
    r = _client(db).get("/devices/7/components/telemetry")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["device_id"] == 7
    by = {c["component_id"]: c for c in body["components"]}
    assert by["remote_support"]["success_rate"] == 1.0
    assert by["agent"]["failed"] == 1
    assert isinstance(by["remote_support"]["operations"], list)
