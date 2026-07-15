import base64

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.agent_auth import verify_heartbeat_request, heartbeat_signature
from app.core.config import settings
from app.db.base import Base
from app.models.device import Device, DeviceStatus
from app.models.device_activity_event import DeviceActivityEvent
from app.schemas.agent import AgentHeartbeatPayload
from app.services.agent_auth_migration_service import AgentAuthMigrationError, AgentAuthMigrationService


def _db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine, tables=[Device.__table__, DeviceActivityEvent.__table__])
    return sessionmaker(bind=engine)()


def _key():
    private = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    der = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return private, base64.b64encode(der).decode()


def _signature(private, challenge):
    value = private.sign(
        challenge.encode(),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.MAX_LENGTH),
        hashes.SHA256(),
    )
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def test_migration_requires_allowlist_proof_approval_and_rejects_replay(monkeypatch):
    db = _db()
    device = Device(hostname="legacy", agent_id="legacy-a", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    db.refresh(device)
    service = AgentAuthMigrationService(db)
    private, public = _key()

    monkeypatch.setattr(settings, "AGENT_AUTH_MIGRATION_MODE", "disabled")
    with pytest.raises(AgentAuthMigrationError, match="migration_not_allowed"):
        service.challenge(device_id=device.id, agent_id=device.agent_id, public_key=public)

    monkeypatch.setattr(settings, "AGENT_AUTH_MIGRATION_MODE", "canary")
    monkeypatch.setattr(settings, "AGENT_AUTH_MIGRATION_DEVICE_IDS", str(device.id))
    with pytest.raises(AgentAuthMigrationError, match="migration_identity_unknown"):
        service.challenge(device_id=device.id, agent_id="claimed-agent", public_key=public)

    issued = service.challenge(device_id=device.id, agent_id=device.agent_id, public_key=public)
    with pytest.raises(AgentAuthMigrationError, match="migration_proof_invalid"):
        service.prove(
            device_id=device.id,
            agent_id=device.agent_id,
            public_key=public,
            challenge=issued["challenge"],
            signature=_signature(_key()[0], issued["challenge"]),
        )
    pending = service.prove(
        device_id=device.id,
        agent_id=device.agent_id,
        public_key=public,
        challenge=issued["challenge"],
        signature=_signature(private, issued["challenge"]),
    )
    assert pending == {"status": "pending_approval", "fingerprint": issued["fingerprint"]}
    with pytest.raises(AgentAuthMigrationError, match="migration_challenge_expired"):
        service.prove(
            device_id=device.id,
            agent_id=device.agent_id,
            public_key=public,
            challenge=issued["challenge"],
            signature=_signature(private, issued["challenge"]),
        )

    service.approve(device, issued["fingerprint"])
    second = service.challenge(device_id=device.id, agent_id=device.agent_id, public_key=public)
    completed = service.prove(
        device_id=device.id,
        agent_id=device.agent_id,
        public_key=public,
        challenge=second["challenge"],
        signature=_signature(private, second["challenge"]),
    )
    encrypted = base64.urlsafe_b64decode(completed["encrypted_credential"] + "==")
    credential = private.decrypt(
        encrypted,
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    ).decode()
    db.refresh(device)
    assert completed["status"] == "completed"
    assert device.id == 1
    assert device.agent_auth_migration_status == "completed"
    assert db.query(DeviceActivityEvent).filter_by(device_id=device.id).count() == 3

    payload = AgentHeartbeatPayload(agent_id=device.agent_id, device_id=device.id)
    body = payload.model_dump_json().encode()
    timestamp = 1_750_000_000_000
    nonce = "migration-nonce-123456"
    headers = {
        "x-techi-agent-id": device.agent_id,
        "x-techi-agent-timestamp": str(timestamp),
        "x-techi-agent-nonce": nonce,
        "x-techi-agent-signature": heartbeat_signature(credential, device.agent_id, timestamp, nonce, body),
    }
    monkeypatch.setattr("app.core.agent_auth.time.time", lambda: timestamp / 1000)
    assert verify_heartbeat_request(db, body=body, headers=headers, payload=payload).id == device.id


def test_migration_rejects_key_change_after_challenge(monkeypatch):
    db = _db()
    device = Device(hostname="legacy", agent_id="legacy-a", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    monkeypatch.setattr(settings, "AGENT_AUTH_MIGRATION_MODE", "fleet")
    first = _key()[1]
    AgentAuthMigrationService(db).challenge(device_id=device.id, agent_id=device.agent_id, public_key=first)
    with pytest.raises(AgentAuthMigrationError, match="migration_key_mismatch"):
        AgentAuthMigrationService(db).challenge(
            device_id=device.id, agent_id=device.agent_id, public_key=_key()[1]
        )
