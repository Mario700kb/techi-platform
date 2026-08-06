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


# --------------------------------------------------------------------------- #
# Non-agent platforms (MikroTik / QNAP / Synology / hypervisors). These used to
# be left ungrouped on purpose; they are now placed in a group named after the
# category display label, which the classification engine's platform rules
# outrank — so holding a real group never changes what the device IS.
# --------------------------------------------------------------------------- #


def _place(platform):
    """Mirrors production: _upsert_device writes payload.platform onto the device
    row and the AssignmentSignal carries the same value, so the stored platform
    and the signal always agree."""
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    dev = Device(hostname="h", platform=platform, device_type=DeviceType.UNASSIGNED,
                 status=DeviceStatus.OFFLINE, assignment_source="unassigned")
    s.add(dev)
    s.commit()
    svc = DeviceAssignmentService(s)
    out = svc.apply_enrollment_assignment(
        dev, client_id=client.id, group_id=None,
        signal=AssignmentSignal(platform=platform),
    )
    group = s.query(DeviceGroup).filter(DeviceGroup.id == out.group_id).first()
    return s, client, out, group


def test_mikrotik_is_placed_in_network_group_created_under_the_client():
    s, client, out, group = _place("mikrotik")
    assert out.client_id == client.id
    assert group is not None and group.name == "Network"
    assert group.client_id == client.id


def test_qnap_and_synology_are_placed_in_storage():
    for platform in ("qnap", "synology"):
        _, _, _, group = _place(platform)
        assert group is not None and group.name == "Storage", platform


def test_hypervisor_platforms_are_placed_in_hypervisors():
    for platform in ("vmware", "proxmox", "hyperv"):
        _, _, _, group = _place(platform)
        assert group is not None and group.name == "Hypervisors", platform


def test_group_membership_does_not_change_the_computed_category():
    """The whole safety argument: a MikroTik holding a real "Network" group must
    still classify as network, not as "other" (the has-a-group fallback)."""
    from app.platform_core import classification as clf

    s, _, out, group = _place("mikrotik")
    device = s.query(Device).filter(Device.id == out.id).first()
    assert clf.classify_category(device) == clf.CATEGORY_NETWORK


def test_standard_groups_are_not_created_for_non_agent_platforms():
    """Servers/Client PC are an agent-platform concept; a MikroTik enrollment
    must not conjure them for the client."""
    s, client, _, _ = _place("mikrotik")
    names = {g.name for g in s.query(DeviceGroup).filter(DeviceGroup.client_id == client.id)}
    assert names == {"Network"}


def test_linux_without_a_server_signal_falls_back_to_client_pc():
    """Documents a REAL GAP, not desired behaviour: AgentEnrollmentRequest has no
    device_type field and the server heuristic is Windows-only, so a Linux server
    enrolling for real (no device_type in the signal) is placed in Client PC."""
    _, _, _, group = _place("linux")
    assert group is not None and group.name == "Client PC"


# --------------------------------------------------------------------------- #
# Regression guard (owner requirement, 2026-08-06): the new category-named
# placement must apply to NEW enrollments only. Every device already in the
# fleet must keep rendering exactly as it does today — same group, same tree
# folder, same Drawer label. These tests fail if any future change lets the
# rule reach an existing device.
# --------------------------------------------------------------------------- #


def _existing(s, *, platform, client_id, group_id, source):
    d = Device(hostname="existing", platform=platform, client_id=client_id, group_id=group_id,
               device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE,
               assignment_source=source)
    s.add(d)
    s.commit()
    return d


def test_existing_placed_device_is_never_re_placed():
    """A device already carrying an authoritative assignment is returned
    untouched, even when the signal would now imply a different group."""
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    grp = DeviceGroup(name="Client PC", client_id=client.id)
    s.add(grp)
    s.commit()
    dev = _existing(s, platform="mikrotik", client_id=client.id, group_id=grp.id,
                    source=DeviceAssignmentService.ENROLLMENT_SOURCE)

    out = DeviceAssignmentService(s).apply_enrollment_assignment(
        dev, client_id=client.id, group_id=None,
        signal=AssignmentSignal(platform="mikrotik"),
    )
    assert out.group_id == grp.id
    assert out.group.name == "Client PC"


def test_existing_ungrouped_device_with_a_client_is_left_ungrouped():
    """Today's MikroTiks have client_id set and group_id NULL, and render under
    the virtual Network folder. The auto path must not retro-create a group for
    them: _can_auto_assign refuses any device that already has a client."""
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    dev = _existing(s, platform="mikrotik", client_id=client.id, group_id=None,
                    source=DeviceAssignmentService.TRUSTED_DOMAIN_SOURCE)

    out = DeviceAssignmentService(s).apply_auto_assignment(
        dev, signal=AssignmentSignal(platform="mikrotik"),
    )
    assert out.group_id is None
    assert {g.name for g in s.query(DeviceGroup).filter(DeviceGroup.client_id == client.id)} == set()


def test_existing_ungrouped_device_renders_identically_after_the_change():
    """Display parity: no real group row, so the Drawer/List "Group" still comes
    from the category label and the tree folder is still Network."""
    from app.platform_core import classification as clf

    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    dev = _existing(s, platform="mikrotik", client_id=client.id, group_id=None,
                    source=DeviceAssignmentService.TRUSTED_DOMAIN_SOURCE)

    resolved = DeviceAssignmentService(s).apply_resolution(dev)
    assert resolved.resolved_group == "Network"
    assert resolved.resolved_client_id == client.id
    assert clf.classify_category(dev) == clf.CATEGORY_NETWORK


def test_auto_path_still_only_knows_the_two_standard_groups():
    """The category-named rule lives in the enrollment path alone. _detect_group
    (trusted-domain / auto placement, which DOES run against existing devices on
    heartbeat) must keep returning only Servers/Client PC."""
    svc = DeviceAssignmentService(_session())
    for platform in ("mikrotik", "qnap", "synology", "vmware", "linux", "windows"):
        assert svc._detect_group(AssignmentSignal(platform=platform)) in ("Servers", "Client PC"), platform
