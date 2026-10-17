"""CPU/memory alerts need sustained load, and no alert is left open forever.

Measured in production (2026-10-11): one sample above the line opened about
1,550 CPU/RAM alerts a day, most closing within ten minutes; Windows sits
above 80% memory routinely. And some open alerts dated back four months:
repeated-reconnect alerts had no closing path, readings-based alerts of a
device that went offline could never be re-evaluated, and archiving a device
left its alerts open.
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow
from app.db.base import Base
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.device import Device, DeviceStatus
from app.models.device_telemetry import DeviceTelemetry
from app.services.alert_engine import AlertEngine
from app.services.device_service import DeviceService
from app.services.device_status_service import DeviceStatusService
from app.tasks.cleanup import find_stale_alerts, resolve_stale_alerts


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def device(db):
    d = Device(hostname="ws-01", rustdesk_id="1", status=DeviceStatus.ONLINE, last_seen=utcnow().replace(tzinfo=None))
    db.add(d)
    db.commit()
    return d


def _samples(db, device, *, cpu=None, ram=None):
    """Store readings oldest first, the way heartbeats arrive."""
    values = cpu if cpu is not None else ram
    start = datetime.utcnow() - timedelta(minutes=5 * len(values))
    for i, value in enumerate(values):
        db.add(DeviceTelemetry(
            device_id=device.id,
            cpu_percent=value if cpu is not None else 10.0,
            ram_percent=value if ram is not None else 40.0,
            created_at=start + timedelta(minutes=5 * i),
        ))
    db.commit()


def _evaluate(db, device, *, cpu=None, ram=None):
    AlertEngine(db).evaluate_telemetry(device, cpu_percent=cpu, ram_percent=ram, disk_percent=None)


def _open(db, device, kind):
    return db.query(DeviceAlert).filter_by(device_id=device.id, kind=kind, state=AlertState.OPEN.value).first()


def test_a_cpu_spike_opens_nothing(db, device):
    _samples(db, device, cpu=[20.0, 30.0, 99.0])
    _evaluate(db, device, cpu=99.0)

    assert _open(db, device, AlertKind.HIGH_CPU) is None


def test_sustained_cpu_load_opens_a_warning_then_critical_needs_its_own_run(db, device):
    _samples(db, device, cpu=[86.0, 88.0, 91.0, 97.0])
    _evaluate(db, device, cpu=97.0)

    alert = _open(db, device, AlertKind.HIGH_CPU)
    assert alert is not None
    assert alert.severity == AlertSeverity.WARNING


def test_sustained_critical_cpu_opens_critical(db, device):
    _samples(db, device, cpu=[96.0, 97.0, 98.0, 100.0])
    _evaluate(db, device, cpu=100.0)

    assert _open(db, device, AlertKind.HIGH_CPU).severity == AlertSeverity.CRITICAL


def test_memory_in_the_eighties_is_normal_for_windows(db, device):
    _samples(db, device, ram=[81.0, 84.0, 86.0])
    _evaluate(db, device, ram=86.0)

    assert _open(db, device, AlertKind.HIGH_RAM) is None


def test_sustained_high_memory_opens_and_closes_with_hysteresis(db, device):
    _samples(db, device, ram=[91.0, 92.0, 93.0, 94.0])
    _evaluate(db, device, ram=94.0)
    assert _open(db, device, AlertKind.HIGH_RAM) is not None

    _samples(db, device, ram=[88.0])
    _evaluate(db, device, ram=88.0)
    assert _open(db, device, AlertKind.HIGH_RAM) is not None, "just under the line must not close it"

    for _ in range(3):
        _samples(db, device, ram=[83.0])
        _evaluate(db, device, ram=83.0)
        assert _open(db, device, AlertKind.HIGH_RAM) is not None, "closing needs four calm samples"
    _samples(db, device, ram=[83.0])
    _evaluate(db, device, ram=83.0)
    assert _open(db, device, AlertKind.HIGH_RAM) is None


def test_a_busy_server_dipping_once_keeps_one_alert(db, device):
    """LogiposSRV-Mensa (17 Oct): heartbeat CPU 100, 100, 50, 92, 100, 0, 100…
    opened 70 five-minute alerts in 3.5 days; it is one alert now."""
    _samples(db, device, cpu=[100.0, 100.0, 92.0, 100.0])
    _evaluate(db, device, cpu=100.0)
    first = _open(db, device, AlertKind.HIGH_CPU)
    assert first is not None
    for value in (0.0, 100.0, 50.0, 100.0, 88.0, 0.0, 100.0):
        _samples(db, device, cpu=[value])
        _evaluate(db, device, cpu=value)
        assert _open(db, device, AlertKind.HIGH_CPU) is not None
    assert db.query(DeviceAlert).filter_by(device_id=device.id, kind=AlertKind.HIGH_CPU).count() == 1


def test_a_disk_hovering_at_the_line_does_not_flap(db, device):
    engine = AlertEngine(db)
    engine.evaluate_telemetry(device, cpu_percent=None, ram_percent=None, disk_percent=86.0)
    assert _open(db, device, AlertKind.LOW_DISK) is not None
    engine.evaluate_telemetry(device, cpu_percent=None, ram_percent=None, disk_percent=84.0)
    assert _open(db, device, AlertKind.LOW_DISK) is not None, "84% is not below the 82% resolve line"
    engine.evaluate_telemetry(device, cpu_percent=None, ram_percent=None, disk_percent=81.0)
    assert _open(db, device, AlertKind.LOW_DISK) is None


def test_reconnect_alert_closes_once_reconnects_settle(db, device):
    engine = AlertEngine(db)
    engine.evaluate_reconnect(device, recent_online_count=4)
    assert _open(db, device, AlertKind.REPEATED_RECONNECTS) is not None

    engine.evaluate_reconnect(device, recent_online_count=0)
    assert _open(db, device, AlertKind.REPEATED_RECONNECTS) is None


def test_going_offline_closes_readings_alerts(db, device):
    _samples(db, device, ram=[96.0, 97.0, 98.0, 98.0])
    _evaluate(db, device, ram=98.0)
    assert _open(db, device, AlertKind.HIGH_RAM) is not None

    device.last_seen = (utcnow() - timedelta(hours=1)).replace(tzinfo=None)
    db.commit()
    DeviceStatusService(db).reconcile_stale_devices()

    assert _open(db, device, AlertKind.HIGH_RAM) is None
    # The offline alert, if one is due, comes from OfflineAlertSweep.
    assert _open(db, device, AlertKind.DEVICE_OFFLINE) is None


def test_archiving_a_device_closes_its_alerts(db, device):
    AlertEngine(db).open_offline_alert(device, severity=AlertSeverity.CRITICAL, message="ws-01 went offline")
    assert _open(db, device, AlertKind.DEVICE_OFFLINE) is not None

    DeviceService(db).archive_device(device.id, archived_by="op")

    assert _open(db, device, AlertKind.DEVICE_OFFLINE) is None


def _stale_alert(db, device, kind, age):
    alert = DeviceAlert(device_id=device.id, kind=kind, severity=AlertSeverity.WARNING, state=AlertState.OPEN,
                        message="x", created_at=datetime.utcnow() - age, updated_at=datetime.utcnow() - age)
    db.add(alert)
    db.commit()
    return alert


def test_the_nightly_sweep_closes_what_nothing_else_would(db):
    offline = Device(hostname="gone", rustdesk_id="2", status=DeviceStatus.OFFLINE)
    archived = Device(hostname="old", rustdesk_id="3", status=DeviceStatus.ONLINE, is_archived=True)
    online = Device(hostname="live", rustdesk_id="4", status=DeviceStatus.ONLINE)
    db.add_all([offline, archived, online])
    db.commit()
    disk_on_offline = _stale_alert(db, offline, AlertKind.LOW_DISK, timedelta(days=120))
    offline_alert = _stale_alert(db, offline, AlertKind.DEVICE_OFFLINE, timedelta(days=60))
    on_archived = _stale_alert(db, archived, AlertKind.HIGH_CPU, timedelta(days=30))
    archived_checkin = _stale_alert(db, archived, AlertKind.ARCHIVED_CHECKIN, timedelta(days=1))
    old_reconnect = _stale_alert(db, online, AlertKind.REPEATED_RECONNECTS, timedelta(days=90))
    live_disk = _stale_alert(db, online, AlertKind.LOW_DISK, timedelta(days=90))

    reasons = {alert.id: reason for alert, reason in find_stale_alerts(db)}
    assert reasons == {
        disk_on_offline.id: "device_offline",
        on_archived.id: "device_archived",
        old_reconnect.id: "reconnects_settled",
    }

    assert resolve_stale_alerts(db) == 3
    for kept in (offline_alert, archived_checkin, live_disk):
        db.refresh(kept)
        assert kept.state == AlertState.OPEN
