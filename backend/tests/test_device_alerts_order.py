"""A device's resolved alerts come newest-resolved first; open ones newest-opened first."""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.device import Device, DeviceStatus, DeviceType
from app.repositories.alert_repository import AlertRepository

T0 = datetime(2026, 10, 12, 12, 0)


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Device(id=1, hostname="PC", device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, registered_at=T0))
    session.commit()
    yield session
    session.close()


def _alert(db, opened_hours_ago, resolved_hours_ago=None):
    created = T0 - timedelta(hours=opened_hours_ago)
    alert = DeviceAlert(
        device_id=1, kind=AlertKind.DEVICE_OFFLINE, severity=AlertSeverity.CRITICAL,
        state=AlertState.RESOLVED if resolved_hours_ago is not None else AlertState.OPEN,
        message=f"opened {opened_hours_ago}h ago", created_at=created, updated_at=created,
        resolved_at=T0 - timedelta(hours=resolved_hours_ago) if resolved_hours_ago is not None else None,
    )
    db.add(alert)
    db.commit()
    return alert.id


def test_recently_resolved_means_resolved_recently(db):
    long_running = _alert(db, opened_hours_ago=72, resolved_hours_ago=1)  # opened 3 days ago, resolved 1 h ago
    brief = _alert(db, opened_hours_ago=10, resolved_hours_ago=9)
    oldest = _alert(db, opened_hours_ago=48, resolved_hours_ago=47)
    ids = [a.id for a in AlertRepository(db).get_by_device(device_id=1, state="resolved")]
    assert ids == [long_running, brief, oldest]


def test_open_alerts_newest_opened_first(db):
    older = _alert(db, opened_hours_ago=5)
    newer = _alert(db, opened_hours_ago=1)
    ids = [a.id for a in AlertRepository(db).get_by_device(device_id=1, state="open")]
    assert ids == [newer, older]
