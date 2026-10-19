"""Deleting a device moves it to the trash and revokes its agent.

Until 2026-10-19 a delete removed the device at once, and the agent still
installed on the machine re-created it with its next heartbeat: a new row, no
client, no history. Now the device can be restored for 30 days, and its agent
is refused (410) until the device is restored or an admin lets it back in.
"""
from datetime import timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.api.v1.endpoints.agent import router as agent_router
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus
from app.models.revoked_agent import RevokedAgent
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import AgentEnrollmentRequest, AgentHeartbeatPayload
from app.services import device_heartbeat_service
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.agent_revocation import AgentRevokedError
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.device_service import DeviceService
from app.services.enrollment_token_service import EnrollmentTokenService
from app.tasks.cleanup import purge_trashed_devices

AGENT_ID = "agent_KEEP_HnW3xK9pQ2rLmT7vZaB4cD"
RUSTDESK_ID = "123456789"


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
        agent_id=AGENT_ID, hostname="old-pc", platform="windows", device_type=DeviceType.CLIENT,
        status=DeviceStatus.ONLINE, rustdesk_id=RUSTDESK_ID, local_ip="10.0.0.9", public_ip="203.0.113.1",
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _beat(db, **fields):
    fields.setdefault("agent_id", AGENT_ID)
    payload = AgentHeartbeatPayload(hostname="old-pc", platform="windows", **fields)
    device, _, _ = DeviceHeartbeatService(db).process_heartbeat_core(payload)
    return device


def _ids(db, state):
    return [d.id for d in DeviceRepository(db).get_multi(lifecycle_state=state)]


def test_trash_revokes_the_agent_and_its_heartbeat_creates_nothing(db, device):
    DeviceService(db).trash_device(device.id, deleted_by="admin", reason="sold")

    with pytest.raises(AgentRevokedError):
        _beat(db, device_id=device.id)
    db.expire_all()
    assert db.query(Device).count() == 1
    row = db.query(RevokedAgent).one()
    assert row.device_id == device.id and row.attempt_count == 1 and row.last_attempt_at is not None


def test_purged_device_does_not_come_back(db, device):
    service = DeviceService(db)
    service.trash_device(device.id, deleted_by="admin", reason="sold")
    service.delete_device(device.id)

    with pytest.raises(AgentRevokedError):
        _beat(db, device_id=device.id, rustdesk_id=RUSTDESK_ID)
    assert db.query(Device).count() == 0


def test_restore_accepts_the_agent_again(db, device):
    service = DeviceService(db)
    service.trash_device(device.id, deleted_by="admin", reason="by mistake")
    restored = service.restore_device(device.id)

    assert restored.deleted_at is None and restored.is_archived is False
    assert db.query(RevokedAgent).count() == 0
    assert _beat(db, device_id=device.id).id == device.id


def test_archive_revokes_and_restore_accepts(db, device):
    service = DeviceService(db)
    service.archive_device(device.id, archived_by="op")
    with pytest.raises(AgentRevokedError):
        _beat(db, device_id=device.id)
    service.restore_device(device.id)
    assert _beat(db, device_id=device.id).id == device.id


def test_an_archived_placeholder_without_revocation_still_beats(db, device):
    # Re-enrollment review archives placeholders through the repository: no
    # revocation, so an approved agent is not locked out.
    DeviceRepository(db).archive(device, archived_by="review")
    assert _beat(db, device_id=device.id).id == device.id


def test_lifecycle_views(db, device):
    other = Device(agent_id="agent_other", hostname="b", platform="windows", device_type=DeviceType.CLIENT)
    db.add(other)
    db.commit()
    service = DeviceService(db)
    service.archive_device(other.id, archived_by="op")
    service.trash_device(device.id, deleted_by="admin", reason="gone")

    assert _ids(db, "active") == []
    assert _ids(db, "archived") == [other.id]
    assert _ids(db, "all") == [other.id]
    assert _ids(db, "trash") == [device.id]


def test_nightly_purge_takes_only_old_trash(db, device):
    recent = Device(agent_id="agent_recent", hostname="r", platform="windows", device_type=DeviceType.CLIENT)
    db.add(recent)
    db.commit()
    service = DeviceService(db)
    service.trash_device(device.id, deleted_by="admin", reason="old")
    service.trash_device(recent.id, deleted_by="admin", reason="new")
    db.get(Device, device.id).deleted_at = utcnow() - timedelta(days=31)
    db.commit()

    assert purge_trashed_devices(db) == 1
    assert [d.id for d in db.query(Device)] == [recent.id]
    assert db.query(RevokedAgent).count() == 2  # the purged agent stays refused


def test_token_install_brings_a_deleted_device_back(db, device):
    service = DeviceService(db)
    service.trash_device(device.id, deleted_by="admin", reason="sold")
    plaintext = "tok-value-0123456789"
    db.add(EnrollmentToken(
        name="T", token_hash=EnrollmentTokenService.hash_token(plaintext), token_prefix=plaintext[:8],
        status=EnrollmentTokenStatus.ACTIVE, max_uses=5, use_count=0,
    ))
    db.commit()

    # Reinstalled with the token: new agent, same Remote Support identity.
    resp = AgentEnrollmentService(db).enroll(
        AgentEnrollmentRequest(
            enrollment_token=plaintext, hostname="old-pc", current_user="u", platform="windows",
            os_name="Windows 11", local_ip="10.0.0.9", public_ip="203.0.113.1", rustdesk_id=RUSTDESK_ID,
        ),
        heartbeat_url="https://x/heartbeat", websocket_url="wss://x/ws",
    )

    assert resp.device_id == device.id
    db.expire_all()
    back = db.get(Device, device.id)
    assert back.deleted_at is None and back.is_archived is False
    assert db.query(RevokedAgent).count() == 0


@pytest.fixture()
def client(db):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.include_router(agent_router, prefix="/api/v1/agent")
    with patch("app.api.v1.endpoints.agent._heartbeat_side_effects"):
        yield TestClient(app)


def test_endpoint_answers_410_to_a_revoked_agent(client, db, device):
    DeviceService(db).trash_device(device.id, deleted_by="admin", reason="sold")
    response = client.post(
        "/api/v1/agent/heartbeat",
        json={"device_id": device.id, "agent_id": AGENT_ID, "hostname": "old-pc", "platform": "windows"},
    )
    assert response.status_code == 410
