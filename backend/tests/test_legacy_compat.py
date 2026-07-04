from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.legacy_compat import router as legacy_router
from app.api.v1.endpoints.agent import router as agent_router
from app.db.base import Base
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        bind=engine,
        tables=[Client.__table__, DeviceGroup.__table__, Device.__table__],
    )
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def client(db):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.include_router(legacy_router)
    app.include_router(agent_router, prefix="/api/v1/agent")
    return TestClient(app, raise_server_exceptions=False)


def test_legacy_heartbeat_empty_body_is_acknowledged(client):
    response = client.post("/api/heartbeat")
    assert response.status_code == 204


def test_legacy_heartbeat_invalid_json_is_acknowledged(client):
    response = client.post(
        "/api/heartbeat",
        content=b"{not-json",
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 204


def test_incomplete_legacy_heartbeat_does_not_create_device(client, db):
    response = client.post("/api/heartbeat", json={"hostname": "legacy-only"})

    assert response.status_code == 204
    assert db.query(Device).count() == 0


def test_current_v1_heartbeat_route_is_unchanged(client):
    device = SimpleNamespace(
        id=7,
        rustdesk_id="123456789",
        device_type="client",
        status="online",
        last_seen=None,
    )
    heartbeat = SimpleNamespace(id=11, created_at=datetime(2026, 1, 1))

    with (
        patch(
            "app.api.v1.endpoints.agent.DeviceHeartbeatService.process_heartbeat_core",
            return_value=(device, heartbeat, {}),
        ),
        patch("app.api.v1.endpoints.agent._heartbeat_side_effects"),
        patch(
            "app.api.v1.endpoints.agent.RemoteActionService.collect_pending_for_delivery",
            return_value=[],
        ),
        patch(
            "app.api.v1.endpoints.agent.RemoteSupportPasswordService.get_or_create",
            return_value="pw-per-device",
        ),
    ):
        response = client.post(
            "/api/v1/agent/heartbeat",
            json={"agent_id": "current-agent", "hostname": "current-host"},
        )

    assert response.status_code == 200
    assert response.json()["device_id"] == 7
    assert response.json()["heartbeat_id"] == 11
    assert response.json()["heartbeat_interval_seconds"] > 0


def test_legacy_heartbeat_for_known_device_returns_json_body(client, db):
    """Old agents treat a bodyless 204 as a failed heartbeat and retry in a
    tight loop (2026-07-03 CPU incident: the legacy route called the v1
    handler with a stale signature, every request blew up and was 'ignored').
    A known device must get the same JSON response the v1 route returns."""
    db.add(Device(id=7, hostname="legacy-host", agent_id="legacy-agent"))
    db.commit()

    device = SimpleNamespace(
        id=7,
        rustdesk_id="123456789",
        device_type="client",
        status="online",
        last_seen=None,
    )
    heartbeat = SimpleNamespace(id=11, created_at=datetime(2026, 1, 1))

    with (
        patch(
            "app.api.v1.endpoints.agent.DeviceHeartbeatService.process_heartbeat_core",
            return_value=(device, heartbeat, {}),
        ),
        patch("app.api.v1.endpoints.agent._heartbeat_side_effects"),
        patch(
            "app.api.v1.endpoints.agent.RemoteActionService.collect_pending_for_delivery",
            return_value=[],
        ),
        patch(
            "app.api.v1.endpoints.agent.RemoteSupportPasswordService.get_or_create",
            return_value="pw-per-device",
        ),
    ):
        response = client.post(
            "/api/heartbeat",
            json={"agent_id": "legacy-agent", "hostname": "legacy-host"},
        )

    assert response.status_code == 200
    assert response.json()["device_id"] == 7
    assert response.json()["heartbeat_id"] == 11


@pytest.mark.parametrize("method", ["get", "post"])
def test_legacy_sysinfo_is_acknowledged(client, method):
    response = getattr(client, method)("/api/sysinfo")
    assert response.status_code == 204
