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


def test_current_v1_heartbeat_rejects_missing_authentication(client):
    response = client.post(
        "/api/v1/agent/heartbeat",
        json={"agent_id": "current-agent", "hostname": "current-host"},
    )

    assert response.status_code == 428
    assert "pending_actions" not in response.text
    assert "remote_support_credential" not in response.text


def test_legacy_heartbeat_for_known_device_requires_reenrollment(client, db):
    db.add(Device(id=7, hostname="legacy-host", agent_id="legacy-agent"))
    db.commit()

    response = client.post(
        "/api/heartbeat",
        json={"agent_id": "legacy-agent", "hostname": "legacy-host"},
    )

    assert response.status_code == 428
    assert response.json()["authentication_required"] is True
    assert "pending_actions" not in response.text
    assert "remote_support_credential" not in response.text


@pytest.mark.parametrize("method", ["get", "post"])
def test_legacy_sysinfo_is_acknowledged(client, method):
    response = getattr(client, method)("/api/sysinfo")
    assert response.status_code == 204
