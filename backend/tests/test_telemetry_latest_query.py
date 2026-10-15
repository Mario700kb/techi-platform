"""Latest telemetry per device: one row per device, the newest one, and the
query must not scan the whole telemetry table."""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.device import Device
from app.models.client_location import ClientLocation, ClientLocationRule
from app.models.device_telemetry import DeviceTelemetry
from app.repositories.device_telemetry_repository import DeviceTelemetryRepository


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine, tables=[ClientLocation.__table__, ClientLocationRule.__table__, Device.__table__, DeviceTelemetry.__table__])
    session = sessionmaker(bind=engine)()
    session.info["engine"] = engine
    yield session
    session.close()


def _device(db, device_id: int) -> None:
    db.add(Device(id=device_id, rustdesk_id=str(device_id), hostname=f"PC-{device_id}", device_type="client",
                  status="online", rustdesk_install_status="installed", rustdesk_status="running",
                  rustdesk_sync_state="synced", rustdesk_manual_override=False, rustdesk_conflict_detected=False))


def _telemetry(db, device_id: int, minutes_ago: int, cpu: float) -> None:
    db.add(DeviceTelemetry(device_id=device_id, cpu_percent=cpu,
                           created_at=datetime(2026, 10, 12, 12, 0) - timedelta(minutes=minutes_ago)))


def _seed(db):
    for device_id in (1, 2, 3):
        _device(db, device_id)
    _telemetry(db, 1, 10, 10.0)
    _telemetry(db, 1, 1, 11.0)   # newest for 1
    _telemetry(db, 1, 5, 12.0)
    _telemetry(db, 2, 3, 20.0)   # only one for 2
    # device 3 has no telemetry
    db.commit()


def test_returns_the_newest_row_per_device(db):
    _seed(db)
    latest = {t.device_id: t.cpu_percent for t in DeviceTelemetryRepository(db).get_latest_all()}
    assert latest == {1: 11.0, 2: 20.0}


def test_filters_to_the_requested_devices(db):
    _seed(db)
    latest = DeviceTelemetryRepository(db).get_latest_for_device_ids([2, 3])
    assert [(t.device_id, t.cpu_percent) for t in latest] == [(2, 20.0)]


def test_empty_id_list_short_circuits(db):
    assert DeviceTelemetryRepository(db).get_latest_for_device_ids([]) == []


def test_query_is_a_per_device_limit_1_not_distinct_on(db):
    _seed(db)
    statements = []
    event.listen(db.info["engine"], "before_cursor_execute",
                 lambda conn, cursor, statement, *args: statements.append(statement))
    DeviceTelemetryRepository(db).get_latest_for_device_ids([1, 2])
    sql = " ".join(statements).upper()
    assert "DISTINCT" not in sql
    assert "LIMIT" in sql
