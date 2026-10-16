"""The public IP comes from the address the agent's request arrives from.

Agents from 2.1.25 no longer ask api.ipify.org for it. uvicorn resolves the
address (from X-Forwarded-For only when the trusted proxy set it), so a
caller's own X-Forwarded-For header must not decide it.
"""
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.api.v1.endpoints.agent import router as agent_router
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.services import device_heartbeat_service

AGENT_ID = "agent_ip_test_HnW3xK9pQ2rLmT7vZaB4"
AGENT_IP = "88.198.53.124"


@pytest.fixture(autouse=True)
def _empty_agent_cache():
    device_heartbeat_service._AGENT_ID_CACHE.clear()
    yield
    device_heartbeat_service._AGENT_ID_CACHE.clear()


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def device(db):
    d = Device(
        agent_id=AGENT_ID,
        hostname="kubiti-sql-srv",
        platform="windows",
        device_type=DeviceType.SERVER,
        status=DeviceStatus.ONLINE,
        rustdesk_id="490082564",
        public_ip="10.0.0.1",
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


@pytest.fixture()
def client(db):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.include_router(agent_router, prefix="/api/v1/agent")
    with patch("app.api.v1.endpoints.agent._heartbeat_side_effects"):
        yield TestClient(app, client=(AGENT_IP, 50000))


def _public_ip(db, device_id):
    db.expire_all()
    return db.query(Device).filter_by(id=device_id).one().public_ip


def _heartbeat(client, device, **extra):
    body = {"agent_id": AGENT_ID, "device_id": device.id, "hostname": "kubiti-sql-srv", "platform": "windows", **extra}
    response = client.post("/api/v1/agent/heartbeat", json=body, headers={"X-Forwarded-For": "203.0.113.66"})
    assert response.status_code == 200
    return response


def test_a_heartbeat_without_public_ip_takes_the_request_address(client, db, device):
    device_id = device.id
    _heartbeat(client, device)
    assert _public_ip(db, device_id) == AGENT_IP


def test_an_older_agent_s_own_public_ip_is_kept(client, db, device):
    device_id = device.id
    _heartbeat(client, device, public_ip="77.242.26.120")
    assert _public_ip(db, device_id) == "77.242.26.120"


def test_enrollment_without_public_ip_takes_the_request_address(client):
    seen = {}

    def fake_enroll(self, payload, **kwargs):
        seen["public_ip"] = payload.public_ip
        raise ValueError("invalid")

    with patch("app.api.v1.endpoints.agent.AgentEnrollmentService.enroll", fake_enroll):
        response = client.post(
            "/api/v1/agent/enroll",
            json={"hostname": "new-pc", "current_user": "user", "platform": "windows", "os_name": "windows",
                  "os_version": "10", "local_ip": "10.0.0.5", "enrollment_token": "x"},
            headers={"X-Forwarded-For": "203.0.113.66"},
        )
    assert response.status_code == 400
    assert seen["public_ip"] == AGENT_IP
