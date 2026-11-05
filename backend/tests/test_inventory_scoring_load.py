"""Health scoring must not load the device's process, service and software
lists: ~47 KB of JSON per device that every heartbeat used to read just to
check the patch status (the top statement by database time, 5 Nov 2026)."""
import json

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow_naive
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.repositories.device_inventory_repository import DeviceInventoryRepository
from app.services.device_health_score_service import DeviceHealthScoreService

LARGE = {"processes_json", "services_json", "software_json"}


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Device(id=7, agent_id="agent_7", hostname="WS-07", platform="windows",
                       device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow_naive()))
    session.add(DeviceInventory(
        device_id=7,
        processes_json=json.dumps([{"name": "a.exe"}] * 50),
        services_json=json.dumps([{"name": "svc"}] * 200),
        software_json=json.dumps([{"name": "app"}] * 100),
        patch_json=json.dumps({"pending_updates": 2, "reboot_required": True}),
        collected_at=utcnow_naive(),
    ))
    session.commit()
    session.expunge_all()
    yield session
    session.close()


def _unloaded(obj) -> set:
    return set(inspect(obj).unloaded)


def test_scoring_reads_patch_status_without_the_large_lists(db):
    row = DeviceInventoryRepository(db).get_for_scoring(7)
    assert LARGE <= _unloaded(row)
    assert json.loads(row.patch_json)["pending_updates"] == 2

    _, _, reasons = DeviceHealthScoreService(db).compute_for_device(db.get(Device, 7), inventory=row)
    assert "Reboot required" in reasons
    assert "2 patch(es) pending" in reasons
    assert LARGE <= _unloaded(row)  # scoring did not lazy-load them


def test_many_rows_skip_the_large_lists(db):
    (row,) = DeviceInventoryRepository(db).get_many_by_device_ids([7])
    assert LARGE <= _unloaded(row)


def test_the_inventory_view_still_gets_the_full_row(db):
    row = DeviceInventoryRepository(db).get_by_device(7)
    assert not (LARGE & _unloaded(row))
    assert len(json.loads(row.services_json)) == 200
