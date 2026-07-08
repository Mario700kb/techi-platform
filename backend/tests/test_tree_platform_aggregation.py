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


def test_category_filter_matches_tree_count_cumulative():
    """Regression: a tree node's filtered result must equal its count badge.
    Reproduces the Agroblend0 case — servers identified by windows_product_type
    (device_type UNASSIGNED) were counted under Servers but excluded by the old
    device_type=server leaf filter. category=servers must match the count."""
    from app.models.device import Device, DeviceStatus, DeviceType
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    import app.models  # noqa: F401
    from app.db.base import Base
    from app.repositories.device_repository import DeviceRepository
    from app.services.device_service import DeviceService

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    s = sessionmaker(bind=engine)()
    s.add_all([
        # 1 explicit server + 2 servers-by-product-type (device_type UNASSIGNED)
        Device(hostname="srv-1", client_id=4, platform="windows", windows_product_type=2,
               device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
        Device(hostname="srv-2", client_id=4, platform="windows", windows_product_type=3,
               device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE),
        Device(hostname="srv-3", client_id=4, platform="windows", windows_product_type=3,
               device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE),
        # 4 workstations
        *[Device(hostname=f"pc-{i}", client_id=4, platform="windows", windows_product_type=1,
                 device_type=DeviceType.CLIENT, status=DeviceStatus.OFFLINE) for i in range(4)],
    ])
    s.commit()
    repo = DeviceRepository(s)
    svc = DeviceService(s)

    agg = repo.count_by_client_category_platform()[4]
    assert agg["servers"]["windows"] == 3
    assert agg["clientpc"]["windows"] == 4

    # THE FIX: category filter reproduces the count (was 1 with device_type=server).
    assert svc.get_devices_count(client_id=4, category="servers", platform="windows") == 3
    assert svc.get_devices_count(client_id=4, category="clientpc", platform="windows") == 4
    # Parent category (no platform) also matches its count.
    assert svc.get_devices_count(client_id=4, category="servers") == 3
