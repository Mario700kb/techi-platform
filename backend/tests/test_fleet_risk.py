"""Dashboard "Security & risk": checks from what the agents already report,
the devices behind each, agent versions, scoping, and recent actions per client."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.scope import AllowedScope
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.models.device_telemetry import DeviceTelemetry
from app.models.remote_action import ActionStatus, RemoteAction
from app.repositories.remote_action_repository import RemoteActionRepository
from app.services import fleet_risk_service as svc

NOW = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)
SECURE = {
    "defender": {"present": True, "antivirus_enabled": True, "realtime_enabled": True, "signature_age_days": 1},
    "firewall": {"domain": True, "private": True, "public": True},
    "bitlocker": {"protection": "on", "system_drive": "C:"},
    "uac_enabled": True,
    "secure_boot": True,
    "local_admins": ["Administrator"],
}


def _naive(dt):
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(svc, "utcnow", lambda: NOW)
    svc.invalidate_risk_cache()
    session = sessionmaker(bind=engine)()
    session.add_all([Client(id=1, name="Northwind", slug="nw"), Client(id=2, name="Harbor", slug="hb")])
    session.commit()
    yield session
    session.close()
    svc.invalidate_risk_cache()


def _device(db, id, name, client_id=1, version="2.1.47", platform="windows", archived=False):
    db.add(Device(id=id, hostname=name, client_id=client_id, agent_version=version, platform=platform,
                  device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=_naive(NOW),
                  is_archived=archived, archived_at=_naive(NOW) if archived else None))
    db.commit()


def _inventory(db, device_id, security=None, health=None):
    db.add(DeviceInventory(device_id=device_id, security_json=json.dumps(security) if security else None,
                           health_json=json.dumps(health) if health else None, collected_at=_naive(NOW)))
    db.commit()


def _check(result, key):
    return next(c for c in result["checks"] if c["key"] == key)


def test_security_and_health_checks_name_the_devices_behind_them(db):
    _device(db, 1, "SECURE")
    _inventory(db, 1, security=SECURE)
    _device(db, 2, "NO-AV")
    _inventory(db, 2, security={**SECURE, "defender": {"present": True, "antivirus_enabled": False}})
    _device(db, 3, "OPEN-FW")
    _inventory(db, 3, security={**SECURE, "firewall": {"domain": False, "private": False, "public": True},
                                "bitlocker": {"protection": "off", "system_drive": "C:"}})
    _device(db, 4, "OLD-RESTART")
    _inventory(db, 4, health={"reboot_pending": True, "reboot_reasons": ["windows_update"],
                              "reboot_pending_since": (NOW - timedelta(days=9)).isoformat(),
                              "disks": [{"name": "Samsung SSD", "health": "unhealthy"}],
                              "events": [{"record_id": 1, "source": "disk", "event_id": 7,
                                          "at": (NOW - timedelta(days=2)).isoformat()}]})
    _device(db, 5, "FULL-DISK", client_id=2)
    db.add(DeviceTelemetry(device_id=5, cpu_percent=5, ram_percent=40, disk_percent=96.4,
                           created_at=_naive(NOW - timedelta(minutes=3))))
    db.commit()

    result = svc.FleetRiskService(db).get_risk()

    assert result["devices"] == 5
    assert result["security"]["reported"] == 3
    assert result["security"]["protected"] == 2
    assert [d["name"] for d in _check(result, "no_antivirus")["devices"]] == ["NO-AV"]
    firewall = _check(result, "firewall_off")
    assert firewall["count"] == 1 and firewall["devices"][0]["detail"] == "Firewall off: Domain, Private"
    assert _check(result, "bitlocker_off")["count"] == 1
    assert _check(result, "reboot_pending")["devices"][0] == {
        "id": 4, "name": "OLD-RESTART", "client_name": "Northwind", "detail": "9 days"}
    assert _check(result, "disk_failing")["devices"][0]["detail"] == "Samsung SSD"
    assert _check(result, "crashes")["count"] == 1
    full = _check(result, "disk_full")
    assert full["devices"][0] == {"id": 5, "name": "FULL-DISK", "client_name": "Harbor", "detail": "96% used"}
    assert _check(result, "realtime_off")["count"] == 0


def _events(*items):
    return {"events": [
        {"record_id": i, "source": source, "event_id": event_id, "at": (NOW - timedelta(hours=hours)).isoformat()}
        for i, (source, event_id, hours) in enumerate(items)
    ]}


POWER = "microsoft-windows-kernel-power"


def test_a_lost_power_is_not_a_crash_and_counts_only_as_a_pattern(db):
    _device(db, 1, "ONE-OFF")  # one shutdown: both events of the same boot
    _inventory(db, 1, health=_events((POWER, 41, 30), ("eventlog", 6008, 30)))
    _device(db, 2, "PATTERN")
    _inventory(db, 2, health=_events((POWER, 41, 30), ("eventlog", 6008, 30), (POWER, 41, 60)))
    db.add(Device(id=3, hostname="SERVER", client_id=1, platform="windows", device_type=DeviceType.SERVER,
                  status=DeviceStatus.ONLINE, last_seen=_naive(NOW)))
    db.commit()
    _inventory(db, 3, health=_events((POWER, 41, 30)))

    result = svc.FleetRiskService(db).get_risk()

    assert _check(result, "crashes")["count"] == 0
    shutdowns = _check(result, "shutdowns")
    assert [(d["name"], d["detail"]) for d in shutdowns["devices"]] == [("PATTERN", "2 shutdowns"), ("SERVER", "1 shutdown")]


def test_real_errors_count_and_a_few_disk_retries_do_not(db):
    _device(db, 1, "BLUE-SCREEN")
    _inventory(db, 1, health=_events(("bugcheck", 1001, 5)))
    _device(db, 2, "USB-RETRIES")
    _inventory(db, 2, health=_events(("disk", 153, 5), ("disk", 153, 6)))
    _device(db, 3, "BAD-DISK")
    _inventory(db, 3, health=_events(("disk", 153, 5), ("disk", 153, 6), ("disk", 51, 7)))

    crashes = _check(svc.FleetRiskService(db).get_risk(), "crashes")

    assert [(d["name"], d["detail"]) for d in crashes["devices"]] == [("BAD-DISK", "3 events"), ("BLUE-SCREEN", "1 event")]


def test_agent_versions_by_family_most_common_first_without_connectors(db):
    for i in range(3):
        _device(db, 10 + i, f"W{i}", version="2.1.47")
    _device(db, 20, "OLD", version="2.1.20")
    _device(db, 21, "PI", version="2.1.39", platform="linux")
    _device(db, 22, "ROUTER", version="1.0", platform="mikrotik")
    _device(db, 23, "GONE", version="2.1.20", archived=True)

    versions = svc.FleetRiskService(db).get_risk()["agent_versions"]

    assert versions == [
        {"family": "windows", "version": "2.1.47", "count": 3},
        {"family": "linux", "version": "2.1.39", "count": 1},
        {"family": "windows", "version": "2.1.20", "count": 1},
    ]


def test_scope_limits_the_devices_counted(db):
    _device(db, 1, "NW-1", client_id=1)
    _inventory(db, 1, security={**SECURE, "defender": {"present": True, "antivirus_enabled": False}})
    _device(db, 2, "HB-1", client_id=2)
    _inventory(db, 2, security={**SECURE, "defender": {"present": True, "antivirus_enabled": False}})

    result = svc.FleetRiskService(db).get_risk(scope=AllowedScope(client_ids=frozenset({2})))

    assert result["devices"] == 1
    assert [d["name"] for d in _check(result, "no_antivirus")["devices"]] == ["HB-1"]


def test_recent_actions_filter_by_client_in_sql(db):
    _device(db, 1, "NW-1", client_id=1)
    _device(db, 2, "HB-1", client_id=2)
    for i in range(30):  # many newer actions on the other client
        db.add(RemoteAction(device_id=1, action_type="sync", status=ActionStatus.COMPLETED,
                            created_at=_naive(NOW - timedelta(minutes=i))))
    db.add(RemoteAction(device_id=2, action_type="restart", status=ActionStatus.COMPLETED,
                        created_at=_naive(NOW - timedelta(hours=5))))
    db.commit()

    actions = RemoteActionRepository(db).get_recent_global(limit=5, scope=AllowedScope(client_ids=frozenset({2})))

    assert [a.device_id for a in actions] == [2]


def test_risk_endpoint_404s_for_an_unknown_client_scope(db):
    from app.api.v1.endpoints.devices import router
    from app.core.auth import get_current_operator, get_operator_scope
    from app.db.session import get_db

    app = FastAPI()
    app.include_router(router, prefix="/devices")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: object()
    # An operator limited to client 1 asking for client 2.
    app.dependency_overrides[get_operator_scope] = lambda: AllowedScope(client_ids=frozenset({1}))
    client = TestClient(app)

    assert client.get("/devices/risk?client_id=2").status_code == 404
    assert client.get("/devices/risk?client_id=1").status_code == 200
