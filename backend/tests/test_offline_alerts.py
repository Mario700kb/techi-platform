"""OfflineAlertSweep: which out-of-contact devices raise an offline alert.

Working hours Mon–Fri 08:00–17:00 Tirana (the defaults). 2026-10-13 is a
Tuesday in summer time (UTC+2); 2026-11-10 a Tuesday in winter time (UTC+1).
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.config import Settings
from app.db.base import Base
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.device import Device, DeviceStatus, DeviceType
from app.services.alert_engine import AlertEngine
from app.services.device_status_service import DeviceStatusService
from app.services.notification_service import NotificationService
from app.services.offline_alerts import OfflineAlertSweep, WorkHours


def tirana(day: int, hour: int, minute: int = 0, month: int = 10) -> datetime:
    """A Tirana wall-clock time in 2026 as aware UTC."""
    offset = 2 if month == 10 else 1
    return datetime(2026, month, day, hour, minute, tzinfo=timezone.utc) - timedelta(hours=offset)


@pytest.fixture()
def db(monkeypatch):
    monkeypatch.setattr(NotificationService, "dispatch", lambda self, **kw: None)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _device(db, last_seen: datetime, *, server=False, **overrides) -> Device:
    fields = dict(
        hostname="srv-01" if server else "ws-01",
        device_type=DeviceType.SERVER if server else DeviceType.CLIENT,
        os_name="Windows Server 2022 Standard" if server else "Windows 11 Pro",
        status=DeviceStatus.OFFLINE,
        last_seen=last_seen.replace(tzinfo=None),
    )
    fields.update(overrides)
    device = Device(**fields)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def _alerts(db, device):
    return (
        db.query(DeviceAlert)
        .filter(DeviceAlert.device_id == device.id, DeviceAlert.kind == AlertKind.DEVICE_OFFLINE)
        .all()
    )


def _sweep(db, now: datetime) -> int:
    return OfflineAlertSweep(db).run(now=now)


# ── Always-on devices ────────────────────────────────────────────────────────


def test_a_server_alerts_after_ten_minutes_at_any_hour(db):
    # Sunday 03:00: outside working hours makes no difference for a server.
    lost = tirana(18, 3)
    server = _device(db, lost, server=True)

    assert _sweep(db, lost + timedelta(minutes=9)) == 0
    assert _sweep(db, lost + timedelta(minutes=10)) == 1

    [alert] = _alerts(db, server)
    assert alert.severity == AlertSeverity.CRITICAL
    assert alert.message == "srv-01 went offline"
    assert "No contact since 18 Oct 03:00." in alert.detail


def test_a_server_shut_down_cleanly_raises_a_warning(db):
    lost = tirana(13, 22)
    server = _device(db, lost, server=True, offline_reason="shutdown")

    _sweep(db, lost + timedelta(minutes=15))

    [alert] = _alerts(db, server)
    assert alert.severity == AlertSeverity.WARNING
    assert alert.message == "srv-01 was shut down"


def test_a_server_group_counts_as_always_on(db):
    from app.models.client import Client
    from app.models.device_group import DeviceGroup

    client = Client(name="Northwind", slug="northwind")
    db.add(client)
    db.commit()
    group = DeviceGroup(name="Servers", client_id=client.id)
    db.add(group)
    db.commit()
    lost = tirana(13, 23)
    nas = _device(db, lost, hostname="nas-01", os_name="Linux", group_id=group.id)

    _sweep(db, lost + timedelta(minutes=10))

    assert [a.severity for a in _alerts(db, nas)] == [AlertSeverity.CRITICAL]


# ── Workstations ─────────────────────────────────────────────────────────────


def test_a_workstation_lost_during_working_hours_alerts_after_two_hours(db):
    lost = tirana(13, 11)
    pc = _device(db, lost)

    assert _sweep(db, lost + timedelta(minutes=119)) == 0
    assert _sweep(db, lost + timedelta(minutes=120)) == 1

    [alert] = _alerts(db, pc)
    assert alert.severity == AlertSeverity.WARNING
    assert alert.message == "ws-01 offline during working hours"
    assert "No contact since 13 Oct 11:00." in alert.detail


def test_lunch_and_leaving_early_raise_nothing(db):
    lunch = _device(db, tirana(13, 12, 30), hostname="lunch")
    early = _device(db, tirana(13, 15, 30), hostname="early")

    _sweep(db, tirana(13, 13, 45))  # back from lunch before two hours
    lunch.status = DeviceStatus.ONLINE
    db.commit()
    for now in (tirana(13, 16, 59), tirana(13, 17, 31), tirana(14, 9)):
        _sweep(db, now)

    assert _alerts(db, lunch) == _alerts(db, early) == []


def test_a_workstation_switched_off_at_the_end_of_the_day_raises_nothing(db):
    lost = tirana(13, 16, 50)
    pc = _device(db, lost)

    for now in (tirana(13, 16, 59), tirana(13, 17, 20), tirana(13, 23), tirana(14, 8, 30), tirana(14, 12)):
        _sweep(db, now)

    assert _alerts(db, pc) == []


def test_a_workstation_off_overnight_is_not_alerted_in_the_morning(db):
    pc = _device(db, tirana(12, 18))

    _sweep(db, tirana(13, 9))

    assert _alerts(db, pc) == []


def test_a_workstation_lost_on_saturday_raises_nothing(db):
    lost = tirana(17, 11)
    pc = _device(db, lost)

    _sweep(db, lost + timedelta(hours=2))

    assert _alerts(db, pc) == []


def test_a_workstation_lost_before_working_hours_raises_nothing(db):
    lost = tirana(13, 7, 40)
    pc = _device(db, lost)

    _sweep(db, tirana(13, 9))

    assert _alerts(db, pc) == []


def test_working_hours_follow_winter_time(db):
    # 10:00 Tirana in November is 09:00 UTC.
    lost = tirana(10, 10, month=11)
    pc = _device(db, lost)

    _sweep(db, lost + timedelta(hours=2))

    [alert] = _alerts(db, pc)
    assert "No contact since 10 Nov 10:00." in alert.detail


# ── Long absence ─────────────────────────────────────────────────────────────


def test_a_device_unseen_for_seven_days_raises_one_warning(db):
    pc = _device(db, tirana(9, 16))

    assert _sweep(db, tirana(16, 15)) == 0
    assert _sweep(db, tirana(16, 16)) == 1
    assert _sweep(db, tirana(18, 3)) == 0  # Sunday: still only the one

    [alert] = _alerts(db, pc)
    assert alert.severity == AlertSeverity.WARNING
    assert alert.message == "ws-01 not seen for 7 days"
    assert "archive it" in alert.detail


def test_long_absence_can_be_switched_off(db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "OFFLINE_ALERT_ABSENT_DAYS", 0)
    pc = _device(db, tirana(1, 16))

    _sweep(db, tirana(18, 3))

    assert _alerts(db, pc) == []


# ── One alert per offline episode ────────────────────────────────────────────


# Alerts are stamped with the real clock, so these episodes lie in the past.


def test_an_alert_closed_by_hand_is_not_reopened_while_the_device_stays_away(db):
    lost = tirana(6, 3)
    server = _device(db, lost, server=True)
    _sweep(db, lost + timedelta(minutes=10))
    [alert] = _alerts(db, server)
    AlertEngine(db).repo.resolve(alert.id, cooldown_seconds=0)

    _sweep(db, lost + timedelta(hours=2))

    assert [a.state for a in _alerts(db, server)] == [AlertState.RESOLVED]


def test_the_alert_closes_when_the_device_returns_and_a_new_episode_can_alert(db):
    lost = tirana(6, 9)
    pc = _device(db, lost)
    _sweep(db, lost + timedelta(hours=2))
    DeviceStatusService(db).mark_online_from_heartbeat(pc)
    [first] = _alerts(db, pc)
    assert first.state == AlertState.RESOLVED
    # Stamp it as it would have been in real time: opened half an hour into
    # the episode, its cooldown long over by the next one.
    first.created_at = (lost + timedelta(hours=2)).replace(tzinfo=None)
    first.last_seen_at = first.created_at
    first.cooldown_until = None
    db.commit()

    # Back for a while, then gone again during working hours.
    lost_again = tirana(6, 12)
    pc.last_seen = lost_again.replace(tzinfo=None)
    pc.status = DeviceStatus.OFFLINE
    db.commit()
    _sweep(db, lost_again + timedelta(hours=2))

    # Gone again the same day: the same alert reopens, counted twice.
    [again] = _alerts(db, pc)
    assert again.state == AlertState.OPEN
    assert again.occurrences == 2


def test_a_closed_working_hours_warning_does_not_hide_the_long_absence_one(db):
    lost = tirana(2, 9)
    pc = _device(db, lost)
    _sweep(db, lost + timedelta(hours=2))
    [first] = _alerts(db, pc)
    first.created_at = (lost + timedelta(hours=2)).replace(tzinfo=None)
    first.last_seen_at = first.created_at
    db.commit()
    AlertEngine(db).repo.resolve(first.id, cooldown_seconds=0)
    # Dismissed that same morning, days before the long-absence one.
    first.resolved_at = first.created_at + timedelta(minutes=5)
    db.commit()

    _sweep(db, tirana(5, 12))  # 3 days: nothing new
    assert len(_alerts(db, pc)) == 1
    _sweep(db, tirana(9, 9))  # 7 days

    messages = sorted(a.message for a in _alerts(db, pc))
    assert messages == ["ws-01 not seen for 7 days", "ws-01 offline during working hours"]
    _sweep(db, tirana(11, 9))
    assert len(_alerts(db, pc)) == 2


def test_archived_and_maintenance_devices_are_skipped(db):
    lost = tirana(13, 3)
    archived = _device(db, lost, server=True, hostname="old-srv", is_archived=True)
    maintained = _device(db, lost, server=True, hostname="maint-srv", is_in_maintenance=True)
    online = _device(db, lost, server=True, hostname="up-srv", status=DeviceStatus.ONLINE)

    _sweep(db, lost + timedelta(hours=1))

    assert _alerts(db, archived) == _alerts(db, maintained) == _alerts(db, online) == []


# ── Moving the open alerts to the new policy ─────────────────────────────────


def test_open_alerts_are_closed_or_rewritten_to_the_new_policy(db):
    now = tirana(13, 18)  # after working hours
    engine = AlertEngine(db)
    evening = _device(db, tirana(13, 17, 30), hostname="evening-pc")
    gone = _device(db, tirana(4, 10), hostname="gone-pc")
    server = _device(db, tirana(13, 16), server=True)
    for device in (evening, gone, server):
        engine.open_offline_alert(device, severity=AlertSeverity.CRITICAL, message=f"{device.hostname} went offline")

    rewritten, closed = OfflineAlertSweep(db).apply_to_open_alerts(now=now)

    assert (rewritten, closed) == (2, 1)
    assert [a.state for a in _alerts(db, evening)] == [AlertState.RESOLVED]
    [absent] = _alerts(db, gone)
    assert (absent.state, absent.severity, absent.message) == (
        AlertState.OPEN,
        AlertSeverity.WARNING,
        "gone-pc not seen for 7 days",
    )
    [down] = _alerts(db, server)
    assert (down.state, down.severity) == (AlertState.OPEN, AlertSeverity.CRITICAL)


# ── Settings ─────────────────────────────────────────────────────────────────


def test_work_hours_settings_parse_from_the_environment(monkeypatch):
    monkeypatch.setenv("WORK_DAYS", "1,2,3,4,5,6")
    monkeypatch.setenv("WORK_START", "7:30")
    monkeypatch.setenv("WORK_END", "18:00")
    parsed = Settings()
    assert parsed.WORK_DAYS == [1, 2, 3, 4, 5, 6]
    assert parsed.WORK_START == "07:30"


def test_a_bad_clock_time_is_rejected(monkeypatch):
    monkeypatch.setenv("WORK_END", "25:00")
    with pytest.raises(ValueError):
        Settings()


def test_the_window_is_none_on_a_day_off():
    hours = WorkHours.from_settings()
    assert hours.window(tirana(18, 12)) is None
    start, end = hours.window(tirana(13, 12))
    assert (start, end) == (tirana(13, 8), tirana(13, 17))
