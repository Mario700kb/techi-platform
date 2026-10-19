"""Remote Support IDs from the ID server's own database (hbbs peer table).

The 1.4.6 clients do not post /api/heartbeat, but every one registers with
hbbs: (id, uuid = MachineGuid, created_at, info {"ip"}). Seen on 19 Oct: one
MachineGuid registered five IDs in a day (cloned machines), while the
platform showed an ID of another machine.
"""
import sqlite3
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
import app.models.audit_log  # noqa: F401
from app.core.time import utcnow_naive
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.remote_support_peer import RemoteSupportPeer
from app.services.hbbs_sync import HbbsSync, clone_groups, read_hbbs
from app.services.remote_support_presence import CACHE, RemoteSupportPresence
from app.services.rustdesk_service import RustDeskIdentityService

DC_GUID = "6ff10fdd-e242-43b3-bd85-54ee5d2431c6"
CLONED_GUID = "0720021f-f874-4bef-a7de-1e27382b81d8"
MOVED_GUID = "11111111-2222-3333-4444-555555555555"


def _hbbs(path, rows):
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE peer (
                guid blob primary key not null, id varchar(100) not null, uuid blob not null, pk blob not null,
                created_at datetime not null default(current_timestamp), user blob, status tinyint,
                note varchar(300), info text not null) without rowid""")
    for i, (rid, guid, created, ip) in enumerate(rows):
        conn.execute("INSERT INTO peer (guid, id, uuid, pk, created_at, info) VALUES (?, ?, ?, ?, ?, ?)",
                     (bytes([i]) * 16, rid, guid.encode(), b"pk", created, '{"ip":"::ffff:%s"}' % ip))
    conn.commit()
    conn.close()


@pytest.fixture(autouse=True)
def _cache():
    CACHE.clear()
    yield
    CACHE.clear()


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Client(id=1, name="SLH", slug="slh"))
    now = utcnow_naive()
    session.add_all([
        Device(id=930, hostname="DC", platform="windows", client_id=1, rustdesk_id="499953668",
               device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE, last_seen=now, public_ip="65.21.204.164"),
        Device(id=931, hostname="APP-01", platform="windows", client_id=1, rustdesk_id="700000001",
               device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE, last_seen=now, public_ip="65.21.204.164"),
        Device(id=932, hostname="TS-01", platform="windows", client_id=1, rustdesk_id="499953666",
               device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE, last_seen=now, public_ip="65.21.204.176"),
    ])
    session.commit()
    yield session
    session.close()


@pytest.fixture()
def hbbs(tmp_path):
    path = tmp_path / "db_v2.sqlite3"
    _hbbs(path, [
        ("499953668", DC_GUID, "2026-10-05 19:00:26", "65.21.204.164"),
        ("700000001", MOVED_GUID, "2026-09-01 10:00:00", "65.21.204.164"),
        ("812345678", MOVED_GUID, "2026-10-18 09:00:00", "65.21.204.164"),
        ("499953666", CLONED_GUID, "2026-10-19 18:00:03", "65.21.204.176"),
        ("8996619", CLONED_GUID, "2026-10-19 18:39:05", "65.21.204.164"),
        ("1109051883", CLONED_GUID, "2026-10-19 19:42:10", "65.21.204.164"),
        ("1529551896", CLONED_GUID, "2026-10-19 19:42:59", "65.21.204.164"),
        ("1378477602", CLONED_GUID, "2026-10-19 19:42:59", "65.21.204.164"),
    ])
    return str(path)


def test_the_id_server_database_is_read_as_machines(hbbs):
    peers = read_hbbs(hbbs)
    assert len(peers) == 8
    dc = next(p for p in peers if p.rustdesk_id == "499953668")
    assert dc.machine_guid == DC_GUID and dc.ip == "65.21.204.164"
    groups = clone_groups(peers)
    assert len(groups) == 1 and next(iter(groups.values()))[0].machine_guid == CLONED_GUID
    assert read_hbbs("/nonexistent/db") == []


def test_ids_are_verified_corrected_and_clones_flagged(db, hbbs):
    summary = HbbsSync(db).run(read_hbbs(hbbs))
    assert summary["clone_groups"] == 1

    dc = db.get(Device, 930)
    assert dc.rustdesk_id == "499953668" and dc.rustdesk_id_source == "id_server"  # its machine has one ID

    moved = db.get(Device, 931)  # its machine registered one newer ID since
    assert moved.rustdesk_id == "812345678" and moved.rustdesk_id_source == "id_server"

    ts = db.get(Device, 932)  # its ID belongs to the cloned group: not "corrected", explained
    assert ts.rustdesk_id == "499953666"
    assert "cloned machines" in ts.rustdesk_sync_message
    notes = {p.rustdesk_id: p.note for p in db.query(RemoteSupportPeer).all()}
    assert notes["1529551896"].startswith("Cloned machine")
    assert db.query(RemoteSupportPeer).count() == 8


def test_an_agent_that_names_its_machine_gets_its_own_id_among_the_clones(db, hbbs):
    dc = db.get(Device, 930)
    dc.machine_guid = CLONED_GUID  # agent 2.1.34 on the machine the owner looked at
    dc.agent_rustdesk_id = "1529551896"  # its fresh --get-id
    db.commit()
    HbbsSync(db).run(read_hbbs(hbbs))
    dc = db.get(Device, 930)
    assert dc.rustdesk_id == "1529551896"
    assert "cloned machines" in dc.rustdesk_sync_message


def test_an_old_agents_stale_reading_does_not_undo_the_correction(db, hbbs):
    HbbsSync(db).run(read_hbbs(hbbs))
    moved = db.get(Device, 931)
    assert RemoteSupportPresence.client_is_authority(moved)
    RustDeskIdentityService(db).apply_heartbeat_sync(
        moved, reported_rustdesk_id="700000001", install_status="installed", rustdesk_status="running",
        version="1.4.6", install_path="C:\\Program Files\\TECHI Remote Support\\TECHI Remote Support.exe",
    )
    assert db.get(Device, 931).rustdesk_id == "812345678"
    # An agent that sends its MachineGuid is trusted again (it reads fresh).
    moved.machine_guid = MOVED_GUID
    db.commit()
    assert not RemoteSupportPresence.client_is_authority(moved)


def test_a_second_run_writes_nothing_new(db, hbbs):
    peers = read_hbbs(hbbs)
    HbbsSync(db).run(peers)
    before = db.get(Device, 930).rustdesk_verified_at
    HbbsSync(db).run(peers)
    assert db.get(Device, 930).rustdesk_verified_at == before
    assert db.query(RemoteSupportPeer).count() == 8


def test_the_wal_is_read_too(tmp_path):
    path = tmp_path / "db_v2.sqlite3"
    _hbbs(path, [("499953668", DC_GUID, "2026-10-05 19:00:26", "1.2.3.4")])
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute("INSERT INTO peer (guid, id, uuid, pk, created_at, info) VALUES (?, ?, ?, ?, ?, ?)",
                 (b"z" * 16, "123456789", DC_GUID.encode(), b"pk", "2026-10-19 10:00:00", "{}"))
    conn.commit()  # stays in the -wal file, the connection still open
    try:
        assert {p.rustdesk_id for p in read_hbbs(str(path))} == {"499953668", "123456789"}
    finally:
        conn.close()


def test_created_at_with_odd_formats(tmp_path):
    path = tmp_path / "db_v2.sqlite3"
    _hbbs(path, [("499953668", DC_GUID, "2026-10-05T19:00:26.123", "1.2.3.4")])
    assert read_hbbs(str(path))[0].created_at == datetime(2026, 10, 5, 19, 0, 26)
    assert timedelta(days=2)  # CLONE_BURST unit sanity
