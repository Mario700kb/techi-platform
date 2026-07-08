"""Regression: heartbeat/reconcile must NEVER undo a manual assignment.

Root cause (pre-fix): device_heartbeat_service cleared the assignment lock and
forced assignment_source=trusted_domain whenever the reported device_type flipped
(e.g. CLIENT->SERVER), which let reconcile re-group a manually-placed device.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register all tables)
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.schemas.agent import AgentHeartbeatPayload
from app.services.device_assignment_service import DeviceAssignmentService
from app.services.device_heartbeat_service import DeviceHeartbeatService


def test_is_manual_locked_covers_exactly_the_locked_sources():
    locked = ["manual", "legacy_manual", "enrollment_token", "MANUAL", "  Manual  "]
    unlocked = ["trusted_domain", "auto_os", "system_auto", "unassigned", "", None]
    for src in locked:
        assert DeviceAssignmentService.is_manual_locked(src) is True, src
    for src in unlocked:
        assert DeviceAssignmentService.is_manual_locked(src) is False, src


def _session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def test_heartbeat_device_type_flip_preserves_manual_assignment():
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.flush()
    # Operator manually placed this device into the "Client PC" group.
    group = DeviceGroup(client_id=client.id, name="Client PC")
    s.add(group)
    s.flush()
    device = Device(
        agent_id="agent_manual_1",
        hostname="ws-01",
        platform="windows",
        os_caption="Microsoft Windows 10 Pro",
        windows_product_type=1,
        device_type=DeviceType.CLIENT,
        client_id=client.id,
        group_id=group.id,
        assignment_source="manual",
        auto_assigned=False,
        status=DeviceStatus.OFFLINE,
    )
    s.add(device)
    s.commit()

    svc = DeviceHeartbeatService(s)
    # Heartbeat now reports a Windows Server product type -> device_type flips to SERVER.
    payload = AgentHeartbeatPayload(
        agent_id="agent_manual_1",
        hostname="ws-01",
        platform="windows",
        os_caption="Microsoft Windows Server 2019 Standard",
        windows_product_type=3,
        domain="acme.local",
    )
    svc.process_heartbeat_core(payload)
    s.refresh(device)

    # The manual placement must be intact despite the device_type flip.
    assert device.assignment_source == "manual"
    assert device.client_id == client.id
    assert device.group_id == group.id
    assert device.auto_assigned is False
    # device_type itself is allowed to reflect reality.
    assert device.device_type == DeviceType.SERVER
    s.close()
