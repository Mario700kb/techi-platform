"""Devices show the RAM that is installed ("4 GB"), not the usable memory
older agents rounded down ("3 GB"), and MikroTik's bytes as a size."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.schemas.agent import AgentHeartbeatPayload
from app.services import device_heartbeat_service
from app.services.device_hardware import installed_ram_label
from app.services.device_heartbeat_service import DeviceHeartbeatService


@pytest.mark.parametrize("ram, version, shown", [
    ("3 GB", "2.1.46", "4 GB"),
    ("7 GB", "2.1.35", "8 GB"),
    ("15 GB", "2.1.20", "16 GB"),
    ("127 GB", None, "128 GB"),
    ("0 GB", "2.1.39", "<1 GB"),
    ("4 GB", "2.1.47", "4 GB"),     # reports installed RAM itself
    ("512 MB", "2.1.47", "512 MB"),
    ("1073741824", "1.0.0", "1 GB"),  # MikroTik bytes
    ("536870912", "1.0.0", "512 MB"),
    ("67108864", "1.0.0", "64 MB"),
    ("16GB", None, "16GB"),          # not an agent's format: left alone
    ("", "2.1.46", ""),
    (None, "2.1.46", None),
])
def test_the_ram_label(ram, version, shown):
    assert installed_ram_label(ram, version) == shown


@pytest.fixture()
def db():
    device_heartbeat_service._AGENT_ID_CACHE.clear()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()
    device_heartbeat_service._AGENT_ID_CACHE.clear()


def test_a_heartbeat_from_an_older_agent_stores_the_installed_size(db):
    device = Device(agent_id="agent_RAM_8Fq3Lp2Wz6Kx", hostname="pos2-qtu", platform="windows",
                    device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, rustdesk_id="323456789", ram="4 GB")
    db.add(device)
    db.commit()
    for _ in range(2):  # the same raw value every time: no drift
        DeviceHeartbeatService(db).process_heartbeat(AgentHeartbeatPayload(
            agent_id="agent_RAM_8Fq3Lp2Wz6Kx", hostname="pos2-qtu", platform="windows",
            rustdesk_id="323456789", agent_version="2.1.46", ram="3 GB"))
    db.expire_all()
    assert db.get(Device, device.id).ram == "4 GB"
