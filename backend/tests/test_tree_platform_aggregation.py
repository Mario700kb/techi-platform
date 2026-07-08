"""Phase 3e — automatic platform aggregation for the Device Tree."""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.repositories.device_repository import DeviceRepository


def _repo():
    # The aggregation groups by client_id and outer-joins device_groups; it does
    # not read the clients table, so no Client row is needed.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add_all([
        Device(hostname="win-srv", client_id=1, platform="windows",
               device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
        Device(hostname="win-legacy-pc", client_id=1, platform=None,
               device_type=DeviceType.CLIENT, status=DeviceStatus.OFFLINE),
        Device(hostname="lin-srv", client_id=1, platform="linux",
               device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
        Device(hostname="lin-desktop", client_id=1, platform="linux",
               device_type=DeviceType.CLIENT, status=DeviceStatus.OFFLINE),
    ])
    session.commit()
    return DeviceRepository(session)


def test_automatic_platform_classification():
    counts = _repo().count_by_client_category_platform()
    # Servers: 1 windows + 1 linux; Client PCs: 1 windows (legacy NULL) + 1 linux
    assert counts[1]["servers"] == {"windows": 1, "linux": 1}
    assert counts[1]["clientpc"] == {"windows": 1, "linux": 1}


def test_null_platform_counts_as_windows():
    counts = _repo().count_by_client_category_platform()
    # The legacy NULL-platform client PC is classified windows (audit §8).
    assert counts[1]["clientpc"].get("windows") == 1


def test_mikrotik_classifies_as_network():
    from app.models.device import Device, DeviceStatus, DeviceType
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    import app.models  # noqa: F401
    from app.db.base import Base
    from app.repositories.device_repository import DeviceRepository
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    s = sessionmaker(bind=engine)()
    s.add_all([
        Device(hostname="rb-core", client_id=1, platform="mikrotik",
               device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE),
        Device(hostname="nas", client_id=1, platform="synology",
               device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE),
        Device(hostname="win-srv", client_id=1, platform="windows",
               device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
    ])
    s.commit()
    counts = DeviceRepository(s).count_by_client_category_platform()
    assert counts[1]["network"] == {"mikrotik": 1}
    assert counts[1]["storage"] == {"synology": 1}
    assert counts[1]["servers"] == {"windows": 1}
