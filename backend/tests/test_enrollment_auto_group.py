"""Step 2 — generic platform-neutral enrollment. A token that carries a Client
but no Default Group must auto-place the device in the correct standard group
(Servers / Client PC) via the Unified Classification Engine, for ANY platform,
with no manual assignment. Platform identity comes from the agent signal.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.services.device_assignment_service import AssignmentSignal, DeviceAssignmentService


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def _device(s, client_id=None):
    d = Device(hostname="h", platform="linux", client_id=client_id,
               device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE,
               assignment_source="unassigned")
    s.add(d)
    s.commit()
    return d


def test_token_client_no_group_autoplaces_linux_server_in_servers():
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    svc = DeviceAssignmentService(s)
    dev = _device(s)

    out = svc.apply_enrollment_assignment(
        dev, client_id=client.id, group_id=None,
        signal=AssignmentSignal(platform="linux", device_type=DeviceType.SERVER),
    )
    assert out.client_id == client.id
    assert out.assignment_source == DeviceAssignmentService.ENROLLMENT_SOURCE
    group = s.query(DeviceGroup).filter(DeviceGroup.id == out.group_id).first()
    assert group.name == "Servers"
    # Standard groups were created for the client.
    names = {g.name for g in s.query(DeviceGroup).filter(DeviceGroup.client_id == client.id)}
    assert {"Servers", "Client PC"} <= names


def test_token_client_no_group_autoplaces_workstation_in_client_pc():
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    svc = DeviceAssignmentService(s)
    dev = _device(s)

    out = svc.apply_enrollment_assignment(
        dev, client_id=client.id, group_id=None,
        signal=AssignmentSignal(platform="linux", device_type=DeviceType.CLIENT),
    )
    group = s.query(DeviceGroup).filter(DeviceGroup.id == out.group_id).first()
    assert group.name == "Client PC"


def test_token_with_explicit_group_is_respected():
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    grp = DeviceGroup(client_id=client.id, name="Custom DC")
    s.add(grp)
    s.commit()
    svc = DeviceAssignmentService(s)
    dev = _device(s)

    out = svc.apply_enrollment_assignment(
        dev, client_id=client.id, group_id=grp.id,
        signal=AssignmentSignal(platform="linux", device_type=DeviceType.SERVER),
    )
    assert out.group_id == grp.id  # explicit default group wins; no auto-derive
    assert out.assignment_source == DeviceAssignmentService.ENROLLMENT_SOURCE


def test_windows_token_client_no_group_still_places_by_signal():
    # Platform-neutral: a Windows server signal (product type) → Servers.
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    svc = DeviceAssignmentService(s)
    dev = _device(s)

    out = svc.apply_enrollment_assignment(
        dev, client_id=client.id, group_id=None,
        signal=AssignmentSignal(platform="windows", windows_product_type=3),
    )
    group = s.query(DeviceGroup).filter(DeviceGroup.id == out.group_id).first()
    assert group.name == "Servers"
