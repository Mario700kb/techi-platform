"""Regression guard for the DeviceService → DeviceRepository filter contract.

The Device Catalog broke (500 "TypeError: get_multi() got an unexpected keyword
argument 'category'") because a commit shipped device_service.py passing a new
filter to the repository without the matching repository change. These tests
exercise the SERVICE (not the repository directly) so any param the service
forwards must exist on the repository — catching that class of mismatch.
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.services.device_service import DeviceService


def _service():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add_all([
        Device(hostname="win-1", platform="windows", device_type=DeviceType.SERVER, status=DeviceStatus.OFFLINE),
        Device(hostname="rb-core", platform="mikrotik", device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE),
    ])
    db.commit()
    return DeviceService(db)


def test_get_devices_default_loads_catalog():
    # The plain catalog call (no expansion filters) must work — this is the
    # SACRED path that regressed.
    svc = _service()
    assert len(svc.get_devices()) == 2
    assert svc.get_devices_count() == 2


def test_get_devices_accepts_platform_and_category():
    # Every filter the endpoint forwards must round-trip service → repository.
    svc = _service()
    assert len(svc.get_devices(platform="windows")) == 1
    assert svc.get_devices_count(platform="windows") == 1
    assert len(svc.get_devices(category="network")) == 1  # mikrotik
    assert svc.get_devices_count(category="network") == 1


def test_all_endpoint_filter_kwargs_are_accepted_by_service():
    """Mirror the endpoint's filter_kwargs and ensure the full call succeeds —
    guards against the service forwarding a kwarg the repository lacks."""
    svc = _service()
    filter_kwargs = dict(
        status=None, device_type=None, freshness_state=None, client_id=None,
        group_id=None, assignment_source=None, lifecycle_state="active",
        search=None, duplicate_candidates=None, maintenance_state=None,
        smart_folder=None, agent_update_state=None, platform=None, category=None,
        scope=None,
    )
    assert svc.get_devices(skip=0, limit=20, **filter_kwargs) is not None
    assert svc.get_devices_count(**filter_kwargs) == 2
