from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401 — register every table on Base.metadata
from app.core.scope import AllowedScope
from app.db.base import Base
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_status_history import DeviceStatusHistory
from app.services import fleet_insights_service as svc

NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(svc, "utcnow", lambda: NOW)
    svc.invalidate_insights_cache()
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _naive(dt):
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _device(db, name, *, status=DeviceStatus.ONLINE, registered=NOW - timedelta(days=90), client_id=None):
    device = Device(hostname=name, device_type=DeviceType.CLIENT, status=status,
                    registered_at=_naive(registered), last_seen=_naive(NOW), client_id=client_id)
    db.add(device)
    db.commit()
    return device


def _transition(db, device, at, new, previous=None):
    db.add(DeviceStatusHistory(device_id=device.id, previous_status=previous, new_status=new,
                               reason="test", created_at=_naive(at)))
    db.commit()


def _alert(db, device, created, resolved=None):
    db.add(DeviceAlert(device_id=device.id, kind=AlertKind.DEVICE_OFFLINE, severity=AlertSeverity.CRITICAL,
                       state=AlertState.RESOLVED if resolved else AlertState.OPEN, message="offline",
                       created_at=_naive(created), updated_at=_naive(created),
                       resolved_at=_naive(resolved) if resolved else None))
    db.commit()


def test_availability_measures_online_time_over_known_time(db):
    steady = _device(db, "STEADY")
    _transition(db, steady, NOW - timedelta(days=40), DeviceStatus.ONLINE)
    flaky = _device(db, "FLAKY", status=DeviceStatus.OFFLINE)
    _transition(db, flaky, NOW - timedelta(days=40), DeviceStatus.ONLINE)
    _transition(db, flaky, NOW - timedelta(days=1), DeviceStatus.OFFLINE, DeviceStatus.ONLINE)

    result = svc.FleetInsightsService(db).get_insights(days=30)["availability"]

    window = (NOW - svc._day_starts(30, NOW)[0]).total_seconds()
    expected = (2 * window - 86400) / (2 * window) * 100
    assert result["overall_pct"] == pytest.approx(expected, abs=0.01)
    assert result["coverage_pct"] == pytest.approx(100.0, abs=0.1)
    assert len(result["series"]) == 30
    assert result["series"][0]["availability_pct"] == 100.0
    assert result["series"][-1]["availability_pct"] < 100.0


def test_unknown_state_is_excluded_not_assumed_online(db):
    device = _device(db, "LATE-HISTORY", registered=NOW - timedelta(days=90))
    # First record in the window carries no previous state: time before it is unknown.
    _transition(db, device, NOW - timedelta(days=2), DeviceStatus.ONLINE)

    result = svc.FleetInsightsService(db).get_insights(days=30)["availability"]

    assert result["overall_pct"] == 100.0
    assert result["coverage_pct"] < 10
    assert result["series"][0]["availability_pct"] is None


def test_alert_trend_counts_and_mean_time_to_resolve(db):
    device = _device(db, "ALERTY")
    _alert(db, device, NOW - timedelta(hours=10), resolved=NOW - timedelta(hours=6))
    _alert(db, device, NOW - timedelta(hours=3))
    _alert(db, device, NOW - timedelta(days=20), resolved=NOW - timedelta(days=19))  # outside 7 days

    trend = svc.FleetInsightsService(db).get_insights(days=30)["alerts"]

    assert trend["opened_total"] == 2
    assert trend["resolved_total"] == 1
    assert trend["open_now"] == 1
    assert trend["mean_time_to_resolve_hours"] == 4.0
    assert len(trend["series"]) == 7


def test_problem_devices_ranked_by_offline_events_and_alerts(db):
    worst = _device(db, "WORST")
    mild = _device(db, "MILD")
    _device(db, "QUIET")
    for hours in (5, 30, 60):
        _transition(db, worst, NOW - timedelta(hours=hours), DeviceStatus.OFFLINE, DeviceStatus.ONLINE)
    _alert(db, worst, NOW - timedelta(hours=4))
    _alert(db, mild, NOW - timedelta(hours=2))

    top = svc.FleetInsightsService(db).get_insights(days=30)["problem_devices"]

    assert [d["name"] for d in top] == ["WORST", "MILD"]
    assert top[0]["offline_events"] == 3 and top[0]["alerts"] == 1


def test_scope_limits_every_figure_to_visible_devices(db):
    acme = Client(name="Acme", slug="acme", is_active=True, created_at=_naive(NOW))
    db.add(acme)
    db.commit()
    mine = _device(db, "MINE", client_id=acme.id)
    other = _device(db, "OTHER")
    _alert(db, mine, NOW - timedelta(hours=1))
    _alert(db, other, NOW - timedelta(hours=1))

    scope = AllowedScope(client_ids={acme.id}, group_ids=set(), device_ids=set())
    result = svc.FleetInsightsService(db).get_insights(scope=scope, days=30)

    assert result["availability"]["device_count"] == 1
    assert result["alerts"]["opened_total"] == 1
    assert [d["name"] for d in result["problem_devices"]] == ["MINE"]
    assert result["problem_devices"][0]["client_name"] == "Acme"


# -- completed days measured once, today recomputed ----------------------------


def _edge_case_fleet(db):
    steady = _device(db, "STEADY")
    _transition(db, steady, NOW - timedelta(days=40), DeviceStatus.ONLINE)
    flaky = _device(db, "FLAKY", status=DeviceStatus.OFFLINE)
    _transition(db, flaky, NOW - timedelta(days=40), DeviceStatus.ONLINE)
    for hours in (300, 200, 30, 5, 2):  # completed days and today
        state = DeviceStatus.OFFLINE if hours in (300, 30, 2) else DeviceStatus.ONLINE
        previous = DeviceStatus.ONLINE if state is DeviceStatus.OFFLINE else DeviceStatus.OFFLINE
        _transition(db, flaky, NOW - timedelta(hours=hours), state, previous)
    _device(db, "NEW", registered=NOW - timedelta(days=3))  # no transitions, registered in window
    late = _device(db, "FIRST-TODAY")
    _transition(db, late, NOW - timedelta(hours=3), DeviceStatus.OFFLINE, DeviceStatus.ONLINE)
    _device(db, "SILENT", status=DeviceStatus.OFFLINE)  # never changed, current status throughout
    return db.query(Device).order_by(Device.id).all()


def test_split_measurement_equals_measuring_the_whole_window(db):
    devices = _edge_case_fleet(db)
    service = svc.FleetInsightsService(db)
    split = service._availability(devices, 30, NOW)

    starts = svc._day_starts(30, NOW)
    bounds = [b.replace(tzinfo=None) for b in starts + [NOW]]
    online, known = [0.0] * 30, [0.0] * 30
    service._measure(devices, bounds, online, known)
    whole = [round(online[i] / known[i] * 100, 2) if known[i] > 0 else None for i in range(30)]

    assert [point["availability_pct"] for point in split["series"]] == whole
    assert split["overall_pct"] == round(sum(online) / sum(known) * 100, 2)


def test_completed_days_are_measured_once_then_only_today(db, monkeypatch):
    devices = _edge_case_fleet(db)
    service = svc.FleetInsightsService(db)
    calls = []
    original = svc.FleetInsightsService._measure

    def counting(self, devs, bounds, online, known):
        calls.append(len(bounds) - 1)
        return original(self, devs, bounds, online, known)

    monkeypatch.setattr(svc.FleetInsightsService, "_measure", counting)
    first = service._availability(devices, 30, NOW)
    assert calls == [29, 1]  # completed days, then today
    calls.clear()
    second = service._availability(devices, 30, NOW)
    assert calls == [1]  # only today
    assert first == second

    # A different device set is a different key: measured in full again.
    calls.clear()
    service._availability(devices[:-1], 30, NOW)
    assert calls == [29, 1]
