"""Data lifecycle (2026-10-19): what the platform keeps and for how long.

device_heartbeats held one full row per heartbeat (634 MB) for a timeline
that showed the last 100; legacy telemetry kept a week for agents that send
pipeline telemetry; one host's failed enrollment wrote ~700 audit rows a day.
"""
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow_naive
from app.db.base import Base
from app.models.alert import DeviceAlert
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_heartbeat import DeviceHeartbeat
from app.models.device_telemetry import DeviceTelemetry
from app.models.enrollment_audit import EnrollmentAudit
from app.models.telemetry_pipeline import DeviceTelemetryState
from app.schemas.agent import AgentEnrollmentRequest, AgentHeartbeatPayload
from app.services import device_heartbeat_service
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.device_activity_service import DeviceActivityService
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.tasks.cleanup import cleanup_old_enrollment_audit, cleanup_old_telemetry, cleanup_resolved_alerts


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


def _device(db, **kw):
    d = Device(agent_id=kw.pop("agent_id", "agent_A"), hostname=kw.pop("hostname", "pc-1"), platform="windows",
               device_type=DeviceType.CLIENT, status=kw.pop("status", DeviceStatus.ONLINE), **kw)
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def test_heartbeat_stores_no_row_and_the_timeline_shows_the_last_one(db):
    device = _device(db)
    payload = AgentHeartbeatPayload(hostname="pc-1", platform="windows", agent_id="agent_A", device_id=device.id)
    for _ in range(3):
        DeviceHeartbeatService(db).process_heartbeat(payload)

    assert db.query(DeviceHeartbeat).count() == 0
    feed = DeviceActivityService(db).get_activity_feed(device.id)
    beats = [e for e in feed if e.type == "heartbeat_received"]
    assert len(beats) == 1 and beats[0].summary == "Last heartbeat"


def test_pipeline_agents_keep_a_day_of_legacy_telemetry_plus_their_newest_row(db):
    now = utcnow_naive()
    pipeline = _device(db, agent_id="agent_P", hostname="p")
    legacy = _device(db, agent_id="agent_L", hostname="l")
    silent = _device(db, agent_id="agent_S", hostname="s")
    db.add_all([
        DeviceTelemetryState(device_id=pipeline.id, policy_version="1.3"),
        DeviceTelemetryState(device_id=silent.id, policy_version="1.3"),
    ])
    for device in (pipeline, legacy):
        for days in (0, 3, 9):
            db.add(DeviceTelemetry(device_id=device.id, cpu_percent=1, created_at=now - timedelta(days=days)))
    db.add(DeviceTelemetry(device_id=silent.id, cpu_percent=1, created_at=now - timedelta(days=3)))
    db.commit()

    cleanup_old_telemetry(db)

    ages = lambda d: sorted(round((now - t.created_at).days) for t in db.query(DeviceTelemetry).filter_by(device_id=d.id))
    assert ages(pipeline) == [0]
    assert ages(legacy) == [0, 3]
    assert ages(silent) == [3]  # its newest row stays


def test_the_open_outage_keeps_its_offline_alert(db):
    old = utcnow_naive() - timedelta(days=120)
    down = _device(db, agent_id="agent_D", hostname="d", status=DeviceStatus.OFFLINE)
    up = _device(db, agent_id="agent_U", hostname="u")
    for device in (down, up):
        db.add(DeviceAlert(device_id=device.id, kind="device_offline", severity="warning", state="resolved",
                           message="m", created_at=old, updated_at=old, resolved_at=old))
    db.commit()

    cleanup_resolved_alerts(db)

    assert [a.device_id for a in db.query(DeviceAlert)] == [down.id]


def test_failed_enrollments_age_out_and_successes_stay(db):
    old = utcnow_naive() - timedelta(days=40)
    db.add_all([
        EnrollmentAudit(result="failed", reason="token_required", hostname="x", created_at=old),
        EnrollmentAudit(result="success", reason="device_created", hostname="y", created_at=old - timedelta(days=200)),
        EnrollmentAudit(result="failed", reason="token_required", hostname="x", created_at=utcnow_naive()),
    ])
    db.commit()

    assert cleanup_old_enrollment_audit(db) == 1
    assert sorted(r.result for r in db.query(EnrollmentAudit)) == ["failed", "success"]


def test_a_repeated_failure_is_recorded_once_an_hour(db):
    request = AgentEnrollmentRequest(enrollment_token="", hostname="kasa1-monch", current_user="u",
                                     platform="windows", os_name="Windows 11", domain="WORKGROUP")
    for _ in range(3):
        with pytest.raises(ValueError):
            AgentEnrollmentService(db).enroll(request, heartbeat_url="h", websocket_url="w")

    assert db.query(EnrollmentAudit).filter_by(result="failed").count() == 1
