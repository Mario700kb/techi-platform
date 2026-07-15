import pytest
import time
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.legacy_compat import router as legacy_router
from app.api.v1.endpoints import agent as agent_endpoint
from app.api.v1.endpoints.agent import router as agent_router
from app.core.agent_auth import heartbeat_identity_limiter, heartbeat_signature, issue_agent_credential
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.agent_command_batch import AgentCommandBatch
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.device_group import DeviceGroup
from app.models.device_heartbeat import DeviceHeartbeat
from app.models.remote_action import ActionStatus, RemoteAction
from app.services.audit_service import AuditAction
from app.services.remote_support_password_service import (
    RemoteSupportPasswordService,
    credential_fingerprint,
)


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        bind=engine,
        tables=[
            Client.__table__,
            DeviceGroup.__table__,
            Device.__table__,
            DeviceHeartbeat.__table__,
            AuditLog.__table__,
            AgentCommandBatch.__table__,
            RemoteAction.__table__,
        ],
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


@pytest.fixture(autouse=True)
def heartbeat_auth_mode(monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "enforce")
    with heartbeat_identity_limiter._lock:
        heartbeat_identity_limiter._hits.clear()


def _signed_headers(device, credential, payload: dict, *, timestamp_ms=None, nonce="nonce-1234567890-abcd"):
    import json

    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    timestamp_ms = timestamp_ms or int(time.time() * 1000)
    return body, {
        "content-type": "application/json",
        "x-techi-agent-id": device.agent_id,
        "x-techi-agent-timestamp": str(timestamp_ms),
        "x-techi-agent-nonce": nonce,
        "x-techi-agent-signature": heartbeat_signature(
            credential, device.agent_id, timestamp_ms, nonce, body
        ),
    }


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


def test_observe_v1_signed_heartbeat_is_accepted_normally(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "observe")
    monkeypatch.setattr(agent_endpoint, "_heartbeat_side_effects", lambda *args, **kwargs: None)
    device = Device(hostname="signed-host", agent_id="signed-agent", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    db.refresh(device)
    credential = issue_agent_credential(device)
    db.add(device)
    db.commit()
    payload = {"agent_id": device.agent_id, "device_id": device.id, "hostname": "signed-new"}
    body, headers = _signed_headers(device, credential, payload)

    response = client.post("/api/v1/agent/heartbeat", content=body, headers=headers)

    assert response.status_code == 200
    assert response.json()["authentication_required"] is False
    db.refresh(device)
    assert device.hostname == "signed-new"


@pytest.mark.parametrize(
    ("version", "expected"),
    [("2.1.11", False), ("2.1.12", True), ("2.2.0", True), ("unknown", False), (None, False)],
)
def test_credential_retry_requires_fixed_agent_version(version, expected):
    assert agent_endpoint._agent_supports_credential_retry(version) is expected


def test_authenticated_remote_support_credential_lifecycle_retries_and_promotes(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "observe")
    monkeypatch.setattr(agent_endpoint, "_heartbeat_side_effects", lambda *args, **kwargs: None)
    device = Device(
        id=12,
        hostname="device-12-equivalent",
        agent_id="signed-device-12",
        agent_version="2.1.12",
        platform="windows",
        rustdesk_install_status="installed",
        rustdesk_status="running",
        remote_support_apply_status="unknown",
        status=DeviceStatus.ONLINE,
    )
    db.add(device)
    db.commit()
    credential = issue_agent_credential(device)
    db.add(device)
    db.commit()

    def heartbeat(extra=None, nonce="nonce-credential-0001"):
        payload = {
            "agent_id": device.agent_id,
            "device_id": device.id,
            "hostname": device.hostname,
            "agent_version": "2.1.12",
            "platform": "windows",
            "rustdesk_install_status": "installed",
            "rustdesk_status": "running",
            "rustdesk_sync_status": "pending",
        }
        payload.update(extra or {})
        body, headers = _signed_headers(device, credential, payload, nonce=nonce)
        return client.post("/api/v1/agent/heartbeat", content=body, headers=headers)

    first = heartbeat()
    assert first.status_code == 200
    generation_one = first.json()["remote_support_credential"]
    assert generation_one["generation"] == 1
    db.refresh(device)
    assert (
        device.remote_support_active_generation,
        device.remote_support_desired_generation,
        device.remote_support_applied_generation,
        device.remote_support_apply_status,
    ) == (0, 1, 0, "pending")

    failed = heartbeat(
        {
            "remote_support_credential_ack": {
                "generation": 1,
                "status": "failed",
                "error": "tray reload timed out",
            }
        },
        nonce="nonce-credential-0002",
    )
    assert failed.status_code == 200
    assert failed.json()["remote_support_credential"]["generation"] == 1
    db.refresh(device)
    assert device.remote_support_active_generation == 0
    assert device.remote_support_apply_status == "failed"

    applied = heartbeat(
        {
            "rustdesk_sync_status": "applied",
            "remote_support_credential_ack": {
                "generation": 1,
                "status": "applied",
                "fingerprint": credential_fingerprint(
                    generation_one["verification_key"],
                    device_id=device.id,
                    generation=1,
                    password=generation_one["password"],
                ),
            },
        },
        nonce="nonce-credential-0003",
    )
    assert applied.status_code == 200
    assert applied.json()["remote_support_credential"] is None
    db.refresh(device)
    assert (
        device.remote_support_active_generation,
        device.remote_support_desired_generation,
        device.remote_support_applied_generation,
        device.remote_support_apply_status,
    ) == (1, 1, 1, "applied")
    assert RemoteSupportPasswordService(db).get_active_plaintext(device) == generation_one["password"]

    generation_two_password = RemoteSupportPasswordService(db).regenerate(device)
    db.refresh(device)
    assert (
        device.remote_support_active_generation,
        device.remote_support_desired_generation,
        device.remote_support_applied_generation,
        device.remote_support_apply_status,
    ) == (1, 2, 1, "pending")

    stale = heartbeat(
        {
            "remote_support_credential_ack": {
                "generation": 1,
                "status": "applied",
                "fingerprint": "0" * 64,
            }
        },
        nonce="nonce-credential-0004",
    )
    assert stale.status_code == 200
    generation_two = stale.json()["remote_support_credential"]
    assert generation_two["generation"] == 2
    assert generation_two["password"] == generation_two_password
    db.refresh(device)
    assert device.remote_support_active_generation == 1
    assert device.remote_support_apply_status == "pending"

    promoted = heartbeat(
        {
            "rustdesk_sync_status": "applied",
            "remote_support_credential_ack": {
                "generation": 2,
                "status": "applied",
                "fingerprint": credential_fingerprint(
                    generation_two["verification_key"],
                    device_id=device.id,
                    generation=2,
                    password=generation_two["password"],
                ),
            },
        },
        nonce="nonce-credential-0005",
    )
    assert promoted.status_code == 200
    db.refresh(device)
    assert (
        device.remote_support_active_generation,
        device.remote_support_desired_generation,
        device.remote_support_applied_generation,
        device.remote_support_apply_status,
    ) == (2, 2, 2, "applied")


def test_observe_v1_missing_auth_accepts_restricted_legacy_path(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "observe")
    device = Device(id=11, hostname="legacy-host", agent_id="legacy-agent", rustdesk_id="123456789")
    db.add(device)
    db.commit()
    RemoteSupportPasswordService(db).ensure_desired(device)
    db.add(
        RemoteAction(
            device_id=device.id,
            action_type="restart_agent",
            status=ActionStatus.QUEUED,
            created_by="operator",
            execution_timeout_seconds=300,
        )
    )
    db.commit()

    response = client.post(
        "/api/v1/agent/heartbeat",
        json={
            "agent_id": "legacy-agent",
            "device_id": 11,
            "hostname": "must-not-update",
            "rustdesk_id": "123456789",
            "remote_support_credential_ack": {"generation": 1, "status": "failed", "error": "nope"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["authentication_required"] is True
    assert body["pending_actions"] == []
    assert body["remote_support_credential"] is None
    db.refresh(device)
    assert device.hostname == "legacy-host"
    assert device.remote_support_apply_status == "pending"
    assert db.query(DeviceHeartbeat).filter(DeviceHeartbeat.device_id == device.id).count() == 1
    audit = db.query(AuditLog).filter(AuditLog.action == AuditAction.AGENT_HEARTBEAT_LEGACY_ACCEPTED).one()
    assert audit.entity_id == device.id
    assert "observe_legacy_missing_auth" in (audit.details_json or "")


def test_observe_v1_missing_auth_rate_limits_by_legacy_identity(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "observe")
    devices = [
        Device(id=i, hostname=f"legacy-{i}", agent_id=f"legacy-agent-{i}")
        for i in range(100, 131)
    ]
    db.add_all(devices)
    db.commit()

    statuses = [
        client.post(
            "/api/v1/agent/heartbeat",
            json={"agent_id": device.agent_id, "device_id": device.id},
        ).status_code
        for device in devices
    ]

    assert statuses == [200] * len(devices)


def test_observe_v1_invalid_signature_is_rejected_not_downgraded(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "observe")
    device = Device(hostname="signed-host", agent_id="signed-agent")
    db.add(device)
    db.commit()
    db.refresh(device)
    credential = issue_agent_credential(device)
    db.add(device)
    db.commit()
    payload = {"agent_id": device.agent_id, "device_id": device.id}
    body, headers = _signed_headers(device, credential, payload)
    headers["x-techi-agent-signature"] = "0" * 64

    response = client.post("/api/v1/agent/heartbeat", content=body, headers=headers)

    assert response.status_code == 401


def test_observe_v1_cross_device_legacy_identity_is_rejected(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "observe")
    db.add_all([
        Device(id=21, hostname="a", agent_id="agent-a"),
        Device(id=22, hostname="b", agent_id="agent-b"),
    ])
    db.commit()

    response = client.post(
        "/api/v1/agent/heartbeat",
        json={"agent_id": "agent-a", "device_id": 22},
    )

    assert response.status_code == 400
    assert "legacy heartbeat requires one existing device identity" in response.text


def test_observe_v1_cross_tenant_legacy_claim_is_rejected(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "observe")
    client_a = Client(id=101, name="A", slug="a")
    client_b = Client(id=102, name="B", slug="b")
    db.add_all([client_a, client_b, Device(id=23, hostname="tenant-a", agent_id="agent-a", client_id=101)])
    db.commit()

    response = client.post(
        "/api/v1/agent/heartbeat",
        json={"agent_id": "agent-a", "device_id": 23, "client_id": 102},
    )

    assert response.status_code == 400
    assert "cross_tenant_identity" in response.text


def test_disabled_v1_missing_auth_is_restricted_and_no_credentials(client, db, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_HEARTBEAT_AUTH_MODE", "disabled")
    device = Device(id=31, hostname="legacy-disabled", agent_id="legacy-disabled")
    db.add(device)
    db.commit()
    RemoteSupportPasswordService(db).ensure_desired(device)
    db.add(
        RemoteAction(
            device_id=device.id,
            action_type="set_remote_password",
            payload='{"password":"legacy-plaintext"}',
            status=ActionStatus.QUEUED,
            created_by="operator",
            execution_timeout_seconds=300,
        )
    )
    db.commit()

    response = client.post(
        "/api/v1/agent/heartbeat",
        json={"agent_id": "legacy-disabled", "device_id": 31, "rustdesk_install_status": "installed"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["authentication_required"] is True
    assert body["pending_actions"] == []
    assert body["agent_update"] is None
    assert body["remote_support_credential"] is None
    db.refresh(device)
    assert device.remote_support_apply_status == "pending"


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
