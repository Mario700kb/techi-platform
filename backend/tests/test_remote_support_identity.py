"""Remote Support's own report of its ID is the truth about it.

TECHI Remote Support posts {id, uuid} to /api/heartbeat every 15 s and its
system info to /api/sysinfo. Before, both were taken for legacy agent
heartbeats and dropped, so a device whose client ID had changed (here
499953668 on the platform, 1529551896 in the client's window) stayed wrong.
"""
import base64
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api import legacy_compat
from app.core.time import utcnow_naive
from app.db.base import Base
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.remote_support_peer import RemoteSupportPeer
from app.services import remote_support_presence as presence
from app.services.remote_support_presence import (
    CACHE,
    RemoteSupportPresence,
    flush,
    guid_from_uuid,
    is_remote_support_report,
)
from app.services.rustdesk_service import RustDeskIdentityService

GUID = "4c4c4544-0042-3510-8052-b4c04f4e3732"
UUID = base64.b64encode(GUID.encode()).decode()
OFFICE_IP = "91.92.10.20"


@pytest.fixture(autouse=True)
def _fresh_cache():
    CACHE.clear()
    legacy_compat.presence_limiter = legacy_compat._SlidingWindowRateLimiter(limit=240, window_seconds=60)
    legacy_compat._started_at = -10_000.0  # past the startup grace
    yield
    CACHE.clear()


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Client(id=1, name="Vasgroup", slug="vas"))
    session.add_all([
        Device(id=1, hostname="RECEPTION-08", platform="windows", client_id=1, rustdesk_id="499953668",
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow_naive(), public_ip=OFFICE_IP),
        Device(id=2, hostname="RECEPTION-09", platform="windows", client_id=1, rustdesk_id="700000001",
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow_naive(), public_ip=OFFICE_IP),
    ])
    session.commit()
    yield session
    session.close()


def _api(db, client_ip=OFFICE_IP):
    app = FastAPI()
    app.include_router(legacy_compat.router)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app, client=(client_ip, 50000))


def _beat(api, rustdesk_id, uuid=UUID):
    return api.post("/api/heartbeat", content=json.dumps({"id": rustdesk_id, "uuid": uuid, "ver": 1004006, "modified_at": 0}))


def _sysinfo(api, rustdesk_id, hostname, uuid=UUID):
    body = {"id": rustdesk_id, "uuid": uuid, "hostname": hostname, "username": "ana.k", "os": "windows / Windows 11 Pro",
            "cpu": "Intel i5, 2.4GHz, 8/4 cores", "memory": "16GB", "version": "1.4.6"}
    return api.post("/api/sysinfo", content=json.dumps(body))


def test_the_uuid_is_the_machine_guid_and_the_report_is_told_from_an_agents():
    assert guid_from_uuid(UUID) == GUID
    assert is_remote_support_report({"id": "1529551896", "uuid": UUID, "ver": 1, "modified_at": 0})
    assert not is_remote_support_report({"agent_id": "agent_x", "rustdesk_id": "1", "uuid": UUID, "id": "1"})
    assert not is_remote_support_report({"id": "abc", "uuid": UUID})


def test_a_changed_id_is_corrected_from_the_clients_own_report(db):
    api = _api(db)
    # The client reports the ID in its window; nothing has it yet.
    assert _beat(api, "1 529 551 896").json() == {"sysinfo": 1}
    assert db.get(Device, 1).rustdesk_id == "499953668"
    # Its system info names the machine, at the device's address: bound and corrected.
    response = _sysinfo(api, "1529551896", "reception-08")
    assert response.text == "SYSINFO_UPDATED"
    device = db.get(Device, 1)
    assert device.rustdesk_id == "1529551896"
    assert device.rustdesk_id_source == "remote_support"
    peer = db.query(RemoteSupportPeer).one()
    assert peer.device_id == 1 and peer.bound_by == "hostname_ip" and peer.machine_guid == GUID
    assert _beat(api, "1529551896").json() == {}


def test_a_known_client_is_answered_from_memory_and_written_once_a_minute(db, monkeypatch):
    api = _api(db)
    _beat(api, "499953668")  # same ID as the device: bound by ID
    assert db.query(RemoteSupportPeer).one().bound_by == "id_match"

    def no_database(*args, **kwargs):
        raise AssertionError("the fast path must not reach the database")

    monkeypatch.setattr(RemoteSupportPresence, "heartbeat", no_database)
    for _ in range(5):
        assert _beat(api, "499953668").status_code == 200
    assert flush(db) == 1
    assert db.get(Device, 1).rustdesk_presence_at is not None


def test_the_agents_stale_reading_gives_way_to_the_client(db):
    api = _api(db)
    _beat(api, "1529551896")
    _sysinfo(api, "1529551896", "RECEPTION-08")
    device = db.get(Device, 1)
    assert RemoteSupportPresence.client_is_authority(device)
    # The agent still reads the old ID from a config file.
    RustDeskIdentityService(db).apply_heartbeat_sync(
        device, reported_rustdesk_id="499953668", install_status="installed", rustdesk_status="running",
        version="1.4.6", install_path="C:\\Program Files\\TECHI Remote Support\\TECHI Remote Support.exe",
    )
    db.refresh(device)
    assert device.rustdesk_id == "1529551896"
    assert "Remote Support reports 1529551896" in device.rustdesk_sync_message
    # Once the client goes quiet for longer than the trust window, the agent counts again.
    device.rustdesk_presence_at = utcnow_naive() - presence.TRUST_WINDOW - timedelta(minutes=1)
    db.commit()
    assert not RemoteSupportPresence.client_is_authority(device)


def test_the_machine_guid_from_the_agent_binds_even_with_another_hostname(db):
    db.get(Device, 2).machine_guid = GUID
    db.commit()
    _beat(_api(db, client_ip="10.0.0.9"), "888888888")
    device = db.get(Device, 2)
    assert device.rustdesk_id == "888888888"
    assert db.query(RemoteSupportPeer).one().bound_by == "machine_guid"


def test_a_hostname_at_another_address_does_not_bind(db):
    api = _api(db, client_ip="203.0.113.7")
    _beat(api, "1529551896")
    _sysinfo(api, "1529551896", "RECEPTION-08")
    assert db.get(Device, 1).rustdesk_id == "499953668"
    assert db.query(RemoteSupportPeer).one().device_id is None


def test_an_id_held_by_another_live_device_is_a_conflict_and_a_dead_one_is_released(db):
    api = _api(db)
    _beat(api, "499953668")  # binds device 1 by its ID
    # Device 1's client now reports device 2's ID.
    _beat(api, "700000001")
    assert db.get(Device, 1).rustdesk_id == "499953668"
    assert db.get(Device, 1).rustdesk_conflict_detected is True
    assert "device #2" in db.get(Device, 1).rustdesk_sync_message

    other = db.get(Device, 2)
    other.is_archived = True
    db.commit()
    CACHE.clear()
    _beat(api, "700000001")
    assert db.get(Device, 1).rustdesk_id == "700000001"
    assert db.get(Device, 2).rustdesk_id is None


def test_a_cloned_machine_reporting_both_ids_does_not_flip_the_device(db):
    api = _api(db)
    _beat(api, "499953668")  # the original, bound by ID
    # Later the copy (same MachineGuid) appears with its own ID…
    peer = db.query(RemoteSupportPeer).one()
    peer.first_seen_at = peer.last_seen_at = utcnow_naive() - timedelta(hours=2)
    db.commit()
    CACHE.clear()
    _beat(api, "1529551896")
    assert db.get(Device, 1).rustdesk_id == "1529551896"  # looks like a changed ID at first
    # …but the original keeps reporting: two machines, not a change.
    CACHE.clear()
    _beat(api, "499953668")
    device = db.get(Device, 1)
    assert device.rustdesk_id == "1529551896"
    assert device.rustdesk_conflict_detected is True and "MachineGuid" in device.rustdesk_sync_message


def test_a_pinned_id_is_left_alone(db):
    device = db.get(Device, 1)
    device.rustdesk_manual_override = True
    db.commit()
    api = _api(db)
    _beat(api, "1529551896")
    _sysinfo(api, "1529551896", "RECEPTION-08")
    assert db.get(Device, 1).rustdesk_id == "499953668"
    assert "pinned" in db.query(RemoteSupportPeer).one().note


def test_an_agent_heartbeat_still_reaches_the_agent_path(db, monkeypatch):
    called = []
    monkeypatch.setattr(legacy_compat, "_resolves_existing_device", lambda payload, db: called.append(payload) or False)
    response = _api(db).post("/api/heartbeat", content=json.dumps({"agent_id": "agent_x", "hostname": "pc", "rustdesk_id": "1"}))
    assert response.status_code == 204 and called


def test_an_operator_binds_an_unmatched_client(db):
    api = _api(db, client_ip="198.51.100.4")
    _beat(api, "1529551896")
    peer = db.query(RemoteSupportPeer).one()
    assert peer.device_id is None
    RemoteSupportPresence(db).bind_manually(peer, db.get(Device, 1), "denis")
    assert db.get(Device, 1).rustdesk_id == "1529551896"
    assert peer.bound_by == "manual"


def test_the_summary_counts_confirmed_and_unmatched(db):
    api = _api(db)
    _beat(api, "499953668")
    _beat(_api(db, client_ip="198.51.100.4"), "123456789", uuid=base64.b64encode(b"other-machine").decode())
    summary = presence.presence_summary(db)
    assert summary["confirmed_24h"] == 1 and summary["unbound_clients_24h"] == 1


def test_the_agent_sends_its_machine_guid():
    from app.schemas.agent import AgentHeartbeatPayload
    from app.services.remote_support_presence import normalize_guid

    payload = AgentHeartbeatPayload.model_validate({"agent_id": "a", "machine_guid": "{" + GUID.upper() + "}"})
    assert normalize_guid(payload.machine_guid) == GUID
    assert normalize_guid("not-a-guid") is None


def test_flush_with_nothing_to_write():
    assert flush(SimpleNamespace()) == 0


def test_the_identity_api_lists_unmatched_clients_and_binds_one(db):
    from app.api.v1.endpoints import remote_support as rs_endpoint
    from app.core.auth import get_current_operator, get_operator_scope
    from app.models.operator import Operator

    db.add(Operator(id=1, username="denis", email="d@x.al", hashed_password="x", role="admin"))
    db.commit()
    _beat(_api(db, client_ip="198.51.100.4"), "1529551896")
    app = FastAPI()
    app.include_router(rs_endpoint.router, prefix="/api/v1/remote-support")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: db.get(Operator, 1)
    app.dependency_overrides[get_operator_scope] = lambda: None
    api = TestClient(app)

    [row] = api.get("/api/v1/remote-support/identity/clients", params={"state": "unbound"}).json()
    assert row["rustdesk_id"] == "1529551896" and row["device_id"] is None
    bound = api.post(f"/api/v1/remote-support/identity/clients/{row['id']}/bind", json={"device_id": 1})
    assert bound.status_code == 200, bound.text
    assert bound.json()["device_rustdesk_id"] == "1529551896"
    assert api.get("/api/v1/remote-support/identity/summary").json()["unbound_clients_24h"] == 0


def test_right_after_a_start_reports_are_answered_without_the_database(db, monkeypatch):
    import time

    monkeypatch.setattr(legacy_compat, "_started_at", time.monotonic())
    assert _beat(_api(db), "1529551896").json() == {}
    assert _sysinfo(_api(db), "1529551896", "RECEPTION-08").text == ""
    assert db.query(RemoteSupportPeer).count() == 0
