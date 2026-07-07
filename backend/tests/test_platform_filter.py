"""Phase 3 — additive platform filter on the device repository."""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register all tables for metadata.create_all)
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.repositories.device_repository import DeviceRepository


def _repo():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add_all([
        Device(hostname="win-1", platform="windows", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
        Device(hostname="win-legacy", platform=None, device_type=DeviceType.CLIENT, status=DeviceStatus.OFFLINE),
        Device(hostname="lin-1", platform="linux", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
        Device(hostname="lin-2", platform="linux", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
    ])
    session.commit()
    return DeviceRepository(session)


def test_no_platform_returns_all():
    repo = _repo()
    assert len(repo.get_multi(lifecycle_state="all")) == 4


def test_linux_filter():
    repo = _repo()
    hosts = {d.hostname for d in repo.get_multi(lifecycle_state="all", platform="linux")}
    assert hosts == {"lin-1", "lin-2"}
    assert repo.count(lifecycle_state="all", platform="linux") == 2


def test_windows_filter_includes_null_platform():
    # Absence of platform ⇒ windows (audit §8): legacy NULL rows count as Windows.
    repo = _repo()
    hosts = {d.hostname for d in repo.get_multi(lifecycle_state="all", platform="windows")}
    assert hosts == {"win-1", "win-legacy"}
