"""Installed software lists TECHI Agent at the version that runs, not the
version its MSI was installed with (self_update swaps only the binary).

Runs the real heartbeat service on SQLite.
"""
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.schemas.agent import AgentHeartbeatPayload
from app.services import device_heartbeat_service
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.device_inventory_service import with_running_agent_version

AGENT_ID = "agent_SOFTWARE_4Kd8Qw2Zr7Np"

AGENT_MSI = {"name": "TECHI Agent", "version": "2.1.20.0", "publisher": "TECHI Solutions SH.P.K.", "uninstall": "msi"}
BRIDGE_MSI = {"name": "TECHI Agent Update Bridge", "version": "2.1.46.0", "publisher": "TECHI Solutions SH.P.K."}
OTHER = {"name": "TeamViewer", "version": "15.1", "publisher": "TeamViewer"}


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
        hostname="pos1-qtu",
        platform="windows",
        device_type=DeviceType.CLIENT,
        status=DeviceStatus.ONLINE,
        rustdesk_id="223456789",
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _stored_software(db, device_id):
    db.expire_all()
    row = db.query(DeviceInventory).filter(DeviceInventory.device_id == device_id).first()
    return {app["name"]: app for app in json.loads(row.software_json)}


def test_the_heartbeat_stores_the_running_agent_version(db, device):
    payload = AgentHeartbeatPayload(
        agent_id=AGENT_ID, hostname="pos1-qtu", platform="windows", rustdesk_id="223456789",
        agent_version="2.1.46", software=[AGENT_MSI, BRIDGE_MSI, OTHER],
    )
    DeviceHeartbeatService(db).process_heartbeat(payload)

    stored = _stored_software(db, device.id)
    assert stored["TECHI Agent"]["version"] == "2.1.46"
    assert stored["TECHI Agent"]["uninstall"] == "msi"  # the rest of the entry is kept
    assert stored["TECHI Agent Update Bridge"]["version"] == "2.1.46.0"
    assert stored["TeamViewer"]["version"] == "15.1"


def test_only_the_techi_agent_entry_changes():
    lookalike = {"name": "TECHI Agent", "version": "9.9", "publisher": "Someone Else"}
    fixed = with_running_agent_version([AGENT_MSI, lookalike, OTHER, "junk"], "2.1.46")
    assert fixed[0]["version"] == "2.1.46"
    assert fixed[1]["version"] == "9.9"
    assert fixed[2] == OTHER
    assert fixed[3] == "junk"
    assert AGENT_MSI["version"] == "2.1.20.0"  # the payload is not mutated


def test_without_a_known_version_the_list_is_untouched():
    software = [AGENT_MSI]
    assert with_running_agent_version(software, None) is software
    assert with_running_agent_version(software, "  ") is software
    assert with_running_agent_version(None, "2.1.46") is None
