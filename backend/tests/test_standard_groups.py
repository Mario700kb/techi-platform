"""Network, Storage and Hypervisors are real groups too: a device put in one by
hand is classified there (in memory and in SQL alike, ahead of what its
platform would say), and the group is made for the client on first use only."""
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.platform_core import classification as clf
from app.services.device_service import DeviceService


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Client(id=1, name="Acme", slug="acme", is_active=True))
    session.commit()
    yield session
    session.close()


def _device(db, device_id, *, platform="windows", group_id=None, client_id=1, caption="Microsoft Windows Server 2019 Standard"):
    db.add(Device(id=device_id, rustdesk_id=f"R{device_id}", hostname=f"h{device_id}", platform=platform,
                  os_caption=caption, windows_product_type=3, client_id=client_id, group_id=group_id,
                  device_type="server", status="online", last_seen=utcnow(), rustdesk_install_status="unknown",
                  rustdesk_status="unknown", rustdesk_sync_state="unknown", assignment_source="auto_os"))
    db.commit()


def _sql_category(db, device_id):
    return db.execute(
        select(clf.category_case()).select_from(Device).outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)
        .where(Device.id == device_id)
    ).scalar_one()


@pytest.mark.parametrize("group, expected", [
    ("Network", "network"), ("Storage", "storage"), ("Hypervisors", "hypervisors"), ("Hypervisor", "hypervisors"),
    ("Other", "other"), ("Servers", "servers"), ("Client PC", "clientpc"),
])
def test_a_standard_group_decides_the_category_in_memory_and_in_sql(db, group, expected):
    db.add(DeviceGroup(id=10, client_id=1, name=group))
    db.commit()
    # A Windows Server would be "servers" by its OS; its group outranks that.
    _device(db, 1, group_id=10)
    device = db.get(Device, 1)
    assert clf.classify_category(device) == expected
    assert _sql_category(db, 1) == expected


def test_without_such_a_group_the_platform_still_decides(db):
    _device(db, 1, platform="mikrotik", caption="RouterOS")
    assert clf.classify_category(db.get(Device, 1)) == "network"
    assert _sql_category(db, 1) == "network"


def test_a_standard_group_is_made_on_first_use_and_reused(db):
    _device(db, 1)
    _device(db, 2)
    service = DeviceService(db)
    first = service.assign_standard_group(1, "Hypervisors")
    second = service.assign_standard_group(2, "Hypervisors")
    groups = db.query(DeviceGroup).filter(DeviceGroup.client_id == 1).all()
    assert [g.name for g in groups] == ["Hypervisors"]
    assert first.group_id == second.group_id == groups[0].id
    # Put there by hand: locked against the automatic assignment.
    assert first.assignment_source == "manual"
    assert clf.classify_category(db.get(Device, 1)) == "hypervisors"


def test_a_device_without_a_client_gets_no_group(db):
    _device(db, 1, client_id=None)
    with pytest.raises(ValueError, match="Assign a client first"):
        DeviceService(db).assign_standard_group(1, "Network")
    assert db.query(DeviceGroup).count() == 0
