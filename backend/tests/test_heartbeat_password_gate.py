"""RISK-SEC-002: the RS password is only returned to a caller that proves it
knows the device's agent_id.

The endpoint is public and unauthenticated by design (agents must reach it),
and it resolves the device from a caller-supplied sequential device_id. Before
this gate, `POST {"device_id": N}` returned that device's remote-support
password in plaintext, making the whole fleet enumerable.

The gate must withhold exactly one response field and nothing else — a
heartbeat from an unauthenticated caller is still processed in full. The
second test below is the important one: it proves we protected the secret
without breaking heartbeat ingestion.
"""
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints.agent import _agent_id_matches
from app.api.v1.endpoints.agent import router as agent_router
from app.db.base import Base
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup

REAL_AGENT_ID = "agent_HnW3xK9pQ2rLmT7vZaB4cD6e"


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
    app.include_router(agent_router, prefix="/api/v1/agent")
    return TestClient(app)


def _heartbeat(client, body, *, agent_id=REAL_AGENT_ID, password="pw-per-device"):
    """Post a heartbeat against a stubbed device carrying `agent_id`.

    Returns (response, get_or_create_mock) so a test can assert both the
    response body and whether the password was even generated.
    """
    device = SimpleNamespace(
        id=42,
        agent_id=agent_id,
        rustdesk_id="123456789",
        device_type="client",
        status="online",
        last_seen=None,
    )
    heartbeat = SimpleNamespace(id=11, created_at=datetime(2026, 7, 29))

    with (
        patch(
            "app.api.v1.endpoints.agent.DeviceHeartbeatService.process_heartbeat_core",
            return_value=(device, heartbeat, {}),
        ) as core,
        patch("app.api.v1.endpoints.agent._heartbeat_side_effects"),
        patch(
            "app.api.v1.endpoints.agent.RemoteActionService.collect_pending_for_delivery",
            return_value=[],
        ),
        patch(
            "app.api.v1.endpoints.agent.RemoteSupportPasswordService.get_or_create",
            return_value=password,
        ) as get_or_create,
    ):
        response = client.post("/api/v1/agent/heartbeat", json=body)
    return response, get_or_create, core


def test_matching_agent_id_receives_the_password(client):
    response, get_or_create, _ = _heartbeat(
        client, {"agent_id": REAL_AGENT_ID, "device_id": 42, "hostname": "ws-01"}
    )

    assert response.status_code == 200
    assert response.json()["remote_support_password"] == "pw-per-device"
    assert get_or_create.called


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"device_id": 42, "hostname": "ws-01"}, id="agent_id-omitted"),
        pytest.param(
            {"agent_id": "", "device_id": 42, "hostname": "ws-01"}, id="agent_id-empty"
        ),
        pytest.param(
            {"agent_id": "agent_wrong", "device_id": 42, "hostname": "ws-01"},
            id="agent_id-wrong",
        ),
        pytest.param(
            {"agent_id": REAL_AGENT_ID[:-1], "device_id": 42, "hostname": "ws-01"},
            id="agent_id-truncated",
        ),
    ],
)
def test_enumeration_by_device_id_yields_no_password(client, body):
    """The attack: name a device_id, get its credentials. Must return a normal
    200 with a null password — and must not even generate one, so probing
    cannot seed a password for a device that has none yet."""
    response, get_or_create, core = _heartbeat(client, body)

    assert response.status_code == 200
    assert response.json()["remote_support_password"] is None
    assert not get_or_create.called

    # The heartbeat itself is still fully processed — withholding the secret
    # must not turn an unauthenticated agent into a device that stops reporting.
    assert core.called
    payload = response.json()
    assert payload["device_id"] == 42
    assert payload["heartbeat_id"] == 11
    assert payload["heartbeat_interval_seconds"] > 0


def test_device_without_agent_id_is_never_unlocked(client):
    """A device with no agent_id on record must not be unlocked by a caller
    that also omits it — otherwise "" == "" would hand over the password."""
    response, get_or_create, _ = _heartbeat(
        client, {"device_id": 42, "hostname": "ws-01"}, agent_id=None
    )

    assert response.status_code == 200
    assert response.json()["remote_support_password"] is None
    assert not get_or_create.called


class TestAgentIdMatches:
    """Unit-level cover for the comparison itself."""

    def test_exact_match(self):
        assert _agent_id_matches(REAL_AGENT_ID, REAL_AGENT_ID)

    def test_surrounding_whitespace_is_tolerated(self):
        assert _agent_id_matches(f"  {REAL_AGENT_ID}\n", REAL_AGENT_ID)

    @pytest.mark.parametrize(
        "provided,stored",
        [
            (None, REAL_AGENT_ID),
            ("", REAL_AGENT_ID),
            ("   ", REAL_AGENT_ID),
            (REAL_AGENT_ID, None),
            (REAL_AGENT_ID, ""),
            (None, None),
            ("", ""),
            (REAL_AGENT_ID.upper(), REAL_AGENT_ID),
            (REAL_AGENT_ID + "x", REAL_AGENT_ID),
        ],
    )
    def test_rejects(self, provided, stored):
        assert not _agent_id_matches(provided, stored)

    def test_mikrotik_style_ids_still_work(self):
        """MikroTik agent_ids are mikrotik-<serial> rather than 144 bits of
        entropy (3 devices in production). They are guessable, which is an
        accepted limitation — the routers do not run Remote Support — but the
        comparison must still function for them."""
        assert _agent_id_matches("mikrotik-HH90AE4EQDX", "mikrotik-HH90AE4EQDX")
        assert not _agent_id_matches("mikrotik-OTHER", "mikrotik-HH90AE4EQDX")
