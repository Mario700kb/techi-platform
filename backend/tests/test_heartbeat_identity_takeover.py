"""A heartbeat that does not carry a device's own agent_id must not change who
the device is.

Until 2026-10-16 the heartbeat resolved the device from a caller-supplied
device_id and then saved the caller's agent_id on it, so the RISK-SEC-002 gate
compared the caller's agent_id with itself and released the device's Remote
Support password and pending actions to anyone, one request per device_id.
test_heartbeat_password_gate.py mocks the heartbeat core and could not see it;
these tests run the real core and endpoint on a real (SQLite) database.
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
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.schemas.agent import AgentHeartbeatPayload
from app.services import device_heartbeat_service
from app.services.device_heartbeat_service import DeviceHeartbeatService

REAL_AGENT_ID = "agent_REAL_HnW3xK9pQ2rLmT7vZaB4cD"
FORGED_AGENT_ID = "attacker-chosen"
REAL_RUSTDESK_ID = "123456789"
ATTACKER_RUSTDESK_ID = "987654321"


@pytest.fixture(autouse=True)
def _empty_agent_cache():
    device_heartbeat_service._AGENT_ID_CACHE.clear()
    yield
    device_heartbeat_service._AGENT_ID_CACHE.clear()


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def victim(db):
    home = Client(name="Home client", slug="home-client")
    other = Client(name="Other client", slug="other-client")
    db.add_all([home, other])
    db.commit()
    device = Device(
        agent_id=REAL_AGENT_ID,
        hostname="victim-pc",
        platform="windows",
        device_type=DeviceType.CLIENT,
        status=DeviceStatus.OFFLINE,
        rustdesk_id=REAL_RUSTDESK_ID,
        client_id=home.id,
        assignment_source="system_auto",
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    device.other_client_id = other.id
    return device


def _beat(db, **fields):
    payload = AgentHeartbeatPayload(hostname="victim-pc", platform="windows", **fields)
    device, _, _ = DeviceHeartbeatService(db).process_heartbeat_core(payload)
    return device


def test_forged_heartbeat_keeps_agent_id_rustdesk_id_and_client(db, victim):
    home_client = victim.client_id
    device = _beat(
        db,
        device_id=victim.id,
        agent_id=FORGED_AGENT_ID,
        rustdesk_id=ATTACKER_RUSTDESK_ID,
        client_id=victim.other_client_id,
    )

    assert device.id == victim.id
    assert device.agent_id == REAL_AGENT_ID
    assert device.rustdesk_id == REAL_RUSTDESK_ID
    assert device.client_id == home_client


def test_second_forged_heartbeat_is_not_trusted_through_the_cache(db, victim):
    _beat(db, device_id=victim.id, agent_id=FORGED_AGENT_ID)
    device = _beat(db, device_id=victim.id, agent_id=FORGED_AGENT_ID, rustdesk_id=ATTACKER_RUSTDESK_ID)

    assert FORGED_AGENT_ID not in device_heartbeat_service._AGENT_ID_CACHE
    assert device.agent_id == REAL_AGENT_ID
    assert device.rustdesk_id == REAL_RUSTDESK_ID


def test_forged_heartbeat_by_rustdesk_id_keeps_agent_id(db, victim):
    device = _beat(db, agent_id=FORGED_AGENT_ID, rustdesk_id=REAL_RUSTDESK_ID)

    assert device.id == victim.id
    assert device.agent_id == REAL_AGENT_ID


def test_forged_heartbeat_is_still_ingested(db, victim):
    device = _beat(db, device_id=victim.id, agent_id=FORGED_AGENT_ID)

    assert device.status == DeviceStatus.ONLINE
    assert device.last_seen is not None


def test_real_agent_still_updates_its_rustdesk_id(db, victim):
    device = _beat(db, device_id=victim.id, agent_id=REAL_AGENT_ID, rustdesk_id=ATTACKER_RUSTDESK_ID)

    assert device.agent_id == REAL_AGENT_ID
    assert device.rustdesk_id == ATTACKER_RUSTDESK_ID


@pytest.fixture()
def client(db):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.include_router(agent_router, prefix="/api/v1/agent")
    with patch("app.api.v1.endpoints.agent._heartbeat_side_effects"):
        yield TestClient(app)


def test_endpoint_withholds_password_from_forged_heartbeats(client, victim):
    for _ in range(2):
        response = client.post(
            "/api/v1/agent/heartbeat",
            json={"device_id": victim.id, "agent_id": FORGED_AGENT_ID, "hostname": "victim-pc", "platform": "windows"},
        )
        assert response.status_code == 200
        assert response.json()["remote_support_password"] is None
        assert response.json()["pending_actions"] == []
        # Naming a device_id must not reveal what an operator connects to.
        assert response.json()["rustdesk_id"] is None


def test_endpoint_gives_password_to_the_real_agent(client, victim):
    response = client.post(
        "/api/v1/agent/heartbeat",
        json={"device_id": victim.id, "agent_id": REAL_AGENT_ID, "hostname": "victim-pc", "platform": "windows"},
    )
    assert response.status_code == 200
    assert response.json()["remote_support_password"]
    assert response.json()["rustdesk_id"] == REAL_RUSTDESK_ID


def test_a_forged_heartbeat_does_not_change_public_ip(db, victim):
    victim.public_ip = "203.0.113.50"
    db.commit()
    device_id = victim.id
    _beat(db, device_id=device_id, agent_id=FORGED_AGENT_ID, public_ip="198.51.100.99")
    db.expire_all()
    assert db.query(Device).get(device_id).public_ip == "203.0.113.50"


def test_the_real_agent_updates_public_ip(db, victim):
    device_id = victim.id
    _beat(db, device_id=device_id, agent_id=REAL_AGENT_ID, public_ip="198.51.100.99")
    db.expire_all()
    assert db.query(Device).get(device_id).public_ip == "198.51.100.99"


def test_a_forged_heartbeat_by_rustdesk_id_is_logged(db, victim, caplog):
    device_heartbeat_service._UNVERIFIED_DEVICE_ID_SEEN.clear()
    with caplog.at_level("WARNING"):
        _beat(db, agent_id=FORGED_AGENT_ID, rustdesk_id=REAL_RUSTDESK_ID)
    assert "RISK-IDENT-001: heartbeat resolved via rustdesk_id" in caplog.text


def test_a_heartbeat_past_the_delivery_deadline_gets_no_actions(client, victim, db):
    from app.core import load_guard
    from app.core.time import utcnow_naive
    from app.models.remote_action import ActionStatus, RemoteAction

    db.add(RemoteAction(device_id=victim.id, action_type="ping", status=ActionStatus.QUEUED, created_by="op", queued_at=utcnow_naive()))
    db.commit()
    with patch.object(load_guard, "DELIVERY_DEADLINE_S", -1.0), \
            patch("app.api.v1.endpoints.agent.DELIVERY_DEADLINE_S", -1.0):
        response = client.post(
            "/api/v1/agent/heartbeat",
            json={"device_id": victim.id, "agent_id": REAL_AGENT_ID, "hostname": "victim-pc", "platform": "windows"},
        )
    assert response.status_code == 200
    assert response.json()["pending_actions"] == []
    assert db.query(RemoteAction).one().status.value == "queued"
