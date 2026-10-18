"""Security posture from the Windows agent (2.1.31): validation, storage only
for the device's own agent, exposure in the inventory API, issues and score.

Runs the real heartbeat service and the real devices router on SQLite.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.api.v1.endpoints import devices as devices_module
from app.core.auth import get_current_operator, get_operator_scope
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.models.operator import Operator
from app.schemas.agent import AgentHeartbeatPayload
from app.schemas.security_posture import (
    MAX_LOCAL_ADMINS,
    MAX_NAME_CHARS,
    MAX_THIRD_PARTY_AV,
    SecurityPosture,
    parse_security_posture,
)
from app.services import device_heartbeat_service
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.security_posture import posture_from_json, posture_issues, posture_score

AGENT_ID = "agent_POSTURE_7Hq2Lm9Xc4Vb"


def _posture(**overrides):
    base = {
        "collected_at": (datetime.now(timezone.utc) - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "defender": {"present": True, "antivirus_enabled": True, "realtime_enabled": True, "signature_age_days": 1},
        "third_party_av": [],
        "firewall": {"domain": True, "private": True, "public": True},
        "bitlocker": {"system_drive": "C:", "protection": "on", "encryption_percent": 100.0},
        "uac_enabled": True,
        "secure_boot": True,
        "local_admins": ["MARIO-LENOVO\\Administrator", "TECHI\\Domain Admins"],
    }
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
def _empty_agent_cache():
    device_heartbeat_service._AGENT_ID_CACHE.clear()
    yield
    device_heartbeat_service._AGENT_ID_CACHE.clear()


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def device(db):
    d = Device(
        agent_id=AGENT_ID,
        hostname="mario-lenovo",
        platform="windows",
        device_type=DeviceType.CLIENT,
        status=DeviceStatus.ONLINE,
        rustdesk_id="123456789",
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _beat(db, **fields):
    payload = AgentHeartbeatPayload(hostname="mario-lenovo", platform="windows", rustdesk_id="123456789", **fields)
    DeviceHeartbeatService(db).process_heartbeat(payload)


def _inventory(db, device_id):
    db.expire_all()
    return db.query(DeviceInventory).filter(DeviceInventory.device_id == device_id).first()


# ── ingestion ─────────────────────────────────────────────────────────────── #

def test_the_devices_own_agent_stores_the_posture(db, device):
    _beat(db, agent_id=AGENT_ID, security_posture=_posture())

    row = _inventory(db, device.id)
    assert row is not None and row.security_json
    stored = SecurityPosture.model_validate_json(row.security_json)
    assert stored.bitlocker.protection == "on"
    assert stored.local_admins == ["MARIO-LENOVO\\Administrator", "TECHI\\Domain Admins"]
    assert row.security_collected_at is not None
    assert abs(row.security_collected_at - stored.collected_at.replace(tzinfo=None)) < timedelta(seconds=1)


def test_an_unverified_heartbeat_cannot_set_the_posture(db, device):
    _beat(db, agent_id=AGENT_ID, security_posture=_posture())
    _beat(
        db,
        agent_id="someone-else",
        device_id=device.id,
        security_posture=_posture(local_admins=["EVIL\\me"], uac_enabled=False),
        patch_status={"pending_updates": 7, "patch_state": "updates_available"},
    )
    _beat(db, device_id=device.id, security_posture=_posture(local_admins=["EVIL\\me"]))

    row = _inventory(db, device.id)
    assert '"pending_updates": 7' in row.patch_json  # the heartbeat did land on this device
    stored = SecurityPosture.model_validate_json(row.security_json)
    assert stored.local_admins == ["MARIO-LENOVO\\Administrator", "TECHI\\Domain Admins"]
    assert stored.uac_enabled is True


def test_an_invalid_posture_is_ignored_and_the_heartbeat_goes_on(db, device):
    _beat(db, agent_id=AGENT_ID, security_posture=_posture())
    _beat(
        db,
        agent_id=AGENT_ID,
        security_posture=_posture(defender="switched off", firewall=["nope"]),
        patch_status={"pending_updates": 2, "patch_state": "updates_available"},
    )

    row = _inventory(db, device.id)
    assert SecurityPosture.model_validate_json(row.security_json).defender.present is True
    assert '"pending_updates": 2' in row.patch_json  # the rest of the inventory was stored


def test_a_posture_that_is_not_an_object_never_fails_the_payload():
    payload = AgentHeartbeatPayload(hostname="x", security_posture="garbage")
    assert payload.security_posture is None
    assert parse_security_posture(["a"]) is None


def test_a_heartbeat_without_posture_keeps_the_stored_one(db, device):
    _beat(db, agent_id=AGENT_ID, security_posture=_posture())
    _beat(db, agent_id=AGENT_ID, software=[{"name": "7-Zip"}])
    row = _inventory(db, device.id)
    assert row.security_json and row.software_json


def test_an_agent_clock_far_off_is_not_believed(db, device):
    _beat(db, agent_id=AGENT_ID, security_posture=_posture(collected_at="2031-01-01T00:00:00Z"))
    row = _inventory(db, device.id)
    assert abs(row.security_collected_at - datetime.now(timezone.utc).replace(tzinfo=None)) < timedelta(minutes=1)


# ── normalisation ─────────────────────────────────────────────────────────── #

def test_unknown_keys_are_dropped_and_sizes_bounded():
    posture = parse_security_posture(
        _posture(
            extra="dropped",
            defender={"present": True, "signature_age_days": -4, "tamper": True},
            third_party_av=["Windows Defender"] + [f"AV {i}" for i in range(30)] + [42],
            local_admins=["  "] + [f"HOST\\user{i:03d}" for i in range(80)] + ["x" * 400],
            bitlocker={"system_drive": "d:", "protection": "Suspended", "encryption_percent": 250},
        )
    )
    dumped = posture.model_dump()
    assert "extra" not in dumped and "tamper" not in dumped["defender"]
    assert posture.defender.signature_age_days is None
    assert len(posture.third_party_av) == MAX_THIRD_PARTY_AV and posture.third_party_av[0] == "AV 0"
    assert len(posture.local_admins) == MAX_LOCAL_ADMINS
    assert all(len(name) <= MAX_NAME_CHARS for name in posture.local_admins)
    assert posture.bitlocker.system_drive == "D:"
    assert posture.bitlocker.protection == "unknown"
    assert posture.bitlocker.encryption_percent == 100.0


def test_an_absent_defender_reports_nothing_enabled():
    posture = parse_security_posture(_posture(defender={"present": False, "antivirus_enabled": True}))
    assert posture.defender.antivirus_enabled is None


def test_a_single_name_is_read_as_a_list():
    assert parse_security_posture(_posture(third_party_av="Sophos Endpoint Agent")).third_party_av == [
        "Sophos Endpoint Agent"
    ]


# ── API ───────────────────────────────────────────────────────────────────── #

@pytest.fixture()
def api(db):
    operator = Operator(username="admin", email="admin@example.com", hashed_password="x", role="admin")
    db.add(operator)
    db.commit()
    fastapi_app = FastAPI()
    fastapi_app.include_router(devices_module.router, prefix="/devices")
    fastapi_app.dependency_overrides[get_db] = lambda: db
    fastapi_app.dependency_overrides[get_current_operator] = lambda: operator
    fastapi_app.dependency_overrides[get_operator_scope] = lambda: None
    return TestClient(fastapi_app)


def test_the_inventory_api_exposes_the_posture(db, device, api):
    body = api.get(f"/devices/{device.id}/inventory").json()
    assert body["security_posture"] is None and body["security_collected_at"] is None

    _beat(db, agent_id=AGENT_ID, security_posture=_posture(secure_boot=None))
    body = api.get(f"/devices/{device.id}/inventory").json()
    posture = body["security_posture"]
    assert set(posture) == {
        "collected_at", "defender", "third_party_av", "firewall", "bitlocker", "uac_enabled", "secure_boot", "local_admins",
    }
    assert posture["defender"] == {
        "present": True, "antivirus_enabled": True, "realtime_enabled": True, "signature_age_days": 1,
    }
    assert posture["firewall"] == {"domain": True, "private": True, "public": True}
    assert posture["bitlocker"] == {"system_drive": "C:", "protection": "on", "encryption_percent": 100.0}
    assert posture["secure_boot"] is None
    assert body["security_collected_at"].endswith("Z") or body["security_collected_at"].endswith("+00:00")


# ── issues and score ──────────────────────────────────────────────────────── #

def test_a_healthy_machine_scores_100():
    assert posture_issues(_posture()) == []
    assert posture_score(_posture()) == 100


def test_unknown_values_cost_nothing():
    unknown = {"defender": {"present": True}, "bitlocker": {"protection": "unknown"}}
    assert posture_issues(unknown) == []
    assert posture_score(unknown) == 100


def test_each_weight():
    cases = [
        (_posture(defender={"present": False}), 65, "No active antivirus"),
        (_posture(defender={"present": True, "antivirus_enabled": True, "realtime_enabled": False}), 80,
         "Defender real-time protection is off"),
        (_posture(defender={"present": True, "antivirus_enabled": True, "signature_age_days": 12}), 90,
         "Antivirus signatures are 12 days old"),
        (_posture(firewall={"domain": True, "private": False, "public": False}), 85, "Firewall off: private, public"),
        (_posture(bitlocker={"protection": "off"}), 90, "BitLocker is off on C:"),
        (_posture(uac_enabled=False), 95, "UAC is off"),
        (_posture(secure_boot=False), 95, "Secure Boot is off"),
    ]
    for posture, score, issue in cases:
        assert posture_score(posture) == score, issue
        assert posture_issues(posture) == [issue]


def test_a_third_party_antivirus_counts_and_passive_defender_is_not_judged():
    posture = _posture(
        defender={"present": True, "antivirus_enabled": False, "realtime_enabled": False, "signature_age_days": 90},
        third_party_av=["ESET Security"],
    )
    assert posture_issues(posture) == []
    assert posture_score(posture) == 100


def test_everything_wrong_counts_each_weight_once():
    worst = _posture(
        defender={"present": True, "antivirus_enabled": False, "realtime_enabled": False, "signature_age_days": 90},
        firewall={"domain": False, "private": False, "public": False},
        bitlocker={"protection": "off"},
        uac_enabled=False,
        secure_boot=False,
    )
    assert posture_issues(worst)[0] == "No active antivirus"
    assert len(posture_issues(worst)) == 5
    assert posture_score(worst) == 30  # 100 − 35 − 15 − 10 − 5 − 5


def test_posture_from_json_reads_the_stored_column():
    stored = parse_security_posture(_posture()).model_dump_json()
    assert posture_score(posture_from_json(stored)) == 100
    assert posture_from_json(None) is None and posture_from_json("{bad") is None
