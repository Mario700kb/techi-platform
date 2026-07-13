import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.agent_auth import (
    AgentAuthError,
    heartbeat_signature,
    issue_agent_credential,
    verify_heartbeat_request,
)
from app.core.config import settings
from app.core.vault_cipher import reset_master_key_cache_for_tests
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.device_group import DeviceGroup
from app.schemas.agent import AgentHeartbeatPayload


def _db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        bind=engine,
        tables=[Client.__table__, DeviceGroup.__table__, Device.__table__],
    )
    return sessionmaker(bind=engine)()


@pytest.fixture(autouse=True)
def _vault_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault.key"))
    reset_master_key_cache_for_tests()
    yield
    reset_master_key_cache_for_tests()


def _device(db, *, agent_id="agent-a", client_id=None):
    device = Device(
        hostname=agent_id,
        agent_id=agent_id,
        client_id=client_id,
        status=DeviceStatus.ONLINE,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    credential = issue_agent_credential(device)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device, credential


def _signed(device, credential, payload, *, timestamp_ms=None, nonce="nonce-1234567890-abcd"):
    body = payload.model_dump_json().encode("utf-8")
    timestamp_ms = timestamp_ms or int(time.time() * 1000)
    return body, {
        "x-techi-agent-id": device.agent_id,
        "x-techi-agent-timestamp": str(timestamp_ms),
        "x-techi-agent-nonce": nonce,
        "x-techi-agent-signature": heartbeat_signature(
            credential, device.agent_id, timestamp_ms, nonce, body
        ),
    }


def test_authenticated_matching_heartbeat_is_accepted():
    db = _db()
    device, credential = _device(db)
    payload = AgentHeartbeatPayload(agent_id=device.agent_id, device_id=device.id)
    body, headers = _signed(device, credential, payload)

    authenticated = verify_heartbeat_request(db, body=body, headers=headers, payload=payload)

    assert authenticated.id == device.id
    assert authenticated.agent_auth_last_nonce == headers["x-techi-agent-nonce"]


def test_replay_is_rejected():
    db = _db()
    device, credential = _device(db)
    payload = AgentHeartbeatPayload(agent_id=device.agent_id, device_id=device.id)
    body, headers = _signed(device, credential, payload)
    verify_heartbeat_request(db, body=body, headers=headers, payload=payload)

    with pytest.raises(AgentAuthError, match="replayed_request"):
        verify_heartbeat_request(db, body=body, headers=headers, payload=payload)


def test_missing_credential_requires_explicit_reenrollment():
    db = _db()
    device = Device(hostname="legacy", agent_id="legacy", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    payload = AgentHeartbeatPayload(agent_id=device.agent_id, device_id=device.id)

    with pytest.raises(AgentAuthError) as exc:
        verify_heartbeat_request(db, body=b"{}", headers={}, payload=payload)

    assert exc.value.status_code == 428


def test_numeric_device_id_impersonation_is_rejected():
    db = _db()
    device_a, credential_a = _device(db, agent_id="agent-a")
    device_b, _ = _device(db, agent_id="agent-b")
    payload = AgentHeartbeatPayload(agent_id=device_a.agent_id, device_id=device_b.id)
    body, headers = _signed(device_a, credential_a, payload)

    with pytest.raises(AgentAuthError, match="cross_device_identity"):
        verify_heartbeat_request(db, body=body, headers=headers, payload=payload)


def test_cross_tenant_claim_is_rejected():
    db = _db()
    client_a = Client(name="A", slug="a")
    client_b = Client(name="B", slug="b")
    db.add_all([client_a, client_b])
    db.commit()
    device, credential = _device(db, client_id=client_a.id)
    payload = AgentHeartbeatPayload(
        agent_id=device.agent_id,
        device_id=device.id,
        client_id=client_b.id,
    )
    body, headers = _signed(device, credential, payload)

    with pytest.raises(AgentAuthError, match="cross_tenant_identity"):
        verify_heartbeat_request(db, body=body, headers=headers, payload=payload)


def test_signature_covers_exact_body_bytes():
    db = _db()
    device, credential = _device(db)
    payload = AgentHeartbeatPayload(agent_id=device.agent_id, device_id=device.id)
    body, headers = _signed(device, credential, payload)

    with pytest.raises(AgentAuthError, match="invalid_signature"):
        verify_heartbeat_request(
            db,
            body=body + b" ",
            headers=headers,
            payload=payload,
        )
