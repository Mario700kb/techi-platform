"""Telemetry pipeline: uploads stored exactly once, rollups, policies, monitor
alerts, and the views the pages read."""
import gzip
import json
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow_naive
from app.db.base import Base
from app.models.alert import AlertKind, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_telemetry import DeviceTelemetry
from app.models.telemetry_pipeline import (
    DeviceTelemetryState,
    MonitoringPolicy,
    TelemetryRollup1h,
    TelemetryRollup5m,
    TelemetrySample,
)
from app.schemas.telemetry_pipeline import MonitorEvent, TelemetryUpload
from app.services import monitoring_policy_service as mps
from app.services.metrics_query_service import MetricsQueryService, disk_trends
from app.services.monitor_alert_service import MonitorAlertService
from app.services.monitoring_policy_service import agent_policy_payload, effective_policy
from app.services.telemetry_ingest_service import TelemetryIngestService, cleanup_telemetry_pipeline

AGENT = "agent_TELEMETRY_0123456789"

WORKSTATION = [
    {"key": "cpu", "metric": "cpu", "op": ">", "threshold": 95, "duration_s": 900, "severity": "critical", "enabled": True},
    {"key": "mem", "metric": "mem", "op": ">", "threshold": 90, "duration_s": 600, "severity": "warning", "enabled": True},
    {"key": "disk", "metric": "disk", "op": ">", "threshold": 90, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "no_data", "metric": "no_data", "op": ">", "threshold": 0, "duration_s": 600, "severity": "critical", "enabled": True},
]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Client(id=1, name="TECHI shpk", slug="techi"))
    session.add_all([
        MonitoringPolicy(id=1, name="Workstations", scope="default", monitors=WORKSTATION, version=1,
                         updated_at=utcnow_naive()),
        MonitoringPolicy(id=2, name="Servers", scope="device_type", scope_value="server", version=5,
                         updated_at=utcnow_naive(), monitors=[
                             {"key": "cpu", "metric": "cpu", "op": ">", "threshold": 90, "duration_s": 900, "severity": "critical", "enabled": True},
                             {"key": "disk_forecast", "metric": "disk_forecast_days", "op": "<", "threshold": 14, "duration_s": 0, "severity": "warning", "enabled": True},
                         ]),
    ])
    session.add_all([
        Device(id=924, agent_id=AGENT, hostname="Mario-Lenovo", platform="windows", client_id=1,
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow_naive()),
        Device(id=781, agent_id="agent_srv", hostname="HV-PROD-01", platform="windows", client_id=1,
               device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE, last_seen=utcnow_naive()),
        Device(id=600, agent_id="agent_old", hostname="Rudi-PC", platform="windows", client_id=1,
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow_naive()),
    ])
    session.commit()
    mps.invalidate_cache()
    yield session
    session.close()
    mps.invalidate_cache()


def _upload(samples, **extra):
    body = {"device_id": 924, "agent_id": AGENT, "policy_version": "1.1", "sample_seconds": 60, "samples": samples}
    body.update(extra)
    return TelemetryUpload.model_validate(body)


def _minutes(start, count, first_seq=1, cpu=lambda i: 10 + i % 7, uptime0=7200, disks=None):
    return [{
        "seq": first_seq + i, "ts": (start + timedelta(minutes=i)).isoformat() + "Z", "cpu": cpu(i), "mem": 40.0,
        "net_rx_bps": 1000.0 * i, "uptime_s": uptime0 + 60 * i,
        "disks": disks or [{"mount": "C:", "used_pct": 54.0, "free_gb": 108.5, "total_gb": 238.0}],
    } for i in range(count)]


def _ingest(db, samples, device_id=924, **extra):
    device = db.get(Device, device_id)
    return TelemetryIngestService(db).ingest(device, _upload(samples, **extra), effective_policy(db, device))


# ── storing ─────────────────────────────────────────────────────────────────

def test_an_upload_is_stored_once_and_acknowledged(db):
    start = (utcnow_naive() - timedelta(minutes=30)).replace(second=0, microsecond=0)
    samples = _minutes(start, 15)
    ack = _ingest(db, samples)
    assert (ack.ack_seq, ack.stored, ack.duplicates, ack.rejected) == (15, 15, 0, 0)

    again = _ingest(db, samples)  # the acknowledgement was lost; the agent resends
    assert (again.ack_seq, again.stored, again.duplicates) == (15, 0, 15)
    assert db.query(TelemetrySample).count() == 15
    state = db.get(DeviceTelemetryState, 924)
    assert state.last_seq == 15 and state.policy_version == "1.1"


def test_rollups_keep_average_peak_and_coverage(db):
    start = utcnow_naive().replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
    _ingest(db, _minutes(start, 60, cpu=lambda i: 90.0 if i == 7 else 10.0))
    five = db.get(TelemetryRollup5m, (924, start + timedelta(minutes=5)))
    assert five.samples == 5 and five.expected == 5
    assert five.cpu_max == 90.0 and five.cpu_avg == pytest.approx((90 + 10 * 4) / 5)
    hour = db.get(TelemetryRollup1h, (924, start))
    assert hour.samples == 60 and hour.expected == 60 and hour.cpu_max == 90.0
    assert hour.disk_max == 54.0 and hour.disks[0]["mount"] == "C:"


def test_an_hour_the_device_was_on_for_a_quarter_is_not_counted_as_lost_data(db):
    hour = utcnow_naive().replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
    _ingest(db, _minutes(hour + timedelta(minutes=45), 15))
    rollup = db.get(TelemetryRollup1h, (924, hour))
    assert (rollup.samples, rollup.expected) == (15, 15)


def test_samples_sent_from_the_buffer_after_an_outage_count_as_late(db):
    start = (utcnow_naive() - timedelta(hours=5)).replace(minute=0, second=0, microsecond=0)
    _ingest(db, _minutes(start, 10))
    assert db.get(TelemetryRollup1h, (924, start)).late == 10


def test_samples_too_old_are_acknowledged_but_not_kept(db):
    old = utcnow_naive() - timedelta(days=9)
    ack = _ingest(db, _minutes(old, 3))
    assert (ack.ack_seq, ack.stored, ack.rejected) == (3, 0, 3)


def test_a_device_clock_off_by_minutes_is_corrected(db):
    now = utcnow_naive().replace(microsecond=0)
    skew = timedelta(minutes=7)
    _ingest(db, _minutes(now - timedelta(minutes=10) + skew, 1), agent_time=(now + skew).isoformat() + "Z")
    sample = db.query(TelemetrySample).one()
    assert abs((sample.ts - (now - timedelta(minutes=10))).total_seconds()) < 5
    assert db.get(DeviceTelemetryState, 924).clock_offset_ms == pytest.approx(skew.total_seconds() * 1000, abs=3000)


# ── the endpoint ────────────────────────────────────────────────────────────

@pytest.fixture()
def client(db, monkeypatch):
    from app.api.v1.endpoints import agent as agent_endpoint

    monkeypatch.setattr(agent_endpoint, "SessionLocal", lambda: _NoClose(db))
    agent_endpoint._telemetry_limiter._hits.clear()
    app = FastAPI()
    app.include_router(agent_endpoint.router, prefix="/api/v1/agent")
    return TestClient(app)


class _NoClose:
    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        return getattr(self._db, name)

    def close(self):
        pass


def test_the_endpoint_accepts_a_gzip_upload(client, db):
    start = (utcnow_naive() - timedelta(minutes=20)).replace(second=0, microsecond=0)
    body = {"device_id": 924, "agent_id": AGENT, "samples": _minutes(start, 5)}
    response = client.post("/api/v1/agent/telemetry", content=gzip.compress(json.dumps(body).encode()),
                           headers={"Content-Encoding": "gzip", "Content-Type": "application/json"})
    assert response.status_code == 200, response.text
    assert response.json()["ack_seq"] == 5
    assert response.json()["policy_version"] == "1.1"


def test_the_endpoint_refuses_a_wrong_agent_id(client):
    body = {"device_id": 924, "agent_id": "someone-else", "samples": []}
    assert client.post("/api/v1/agent/telemetry", json=body).status_code == 403
    assert client.post("/api/v1/agent/telemetry", json={"device_id": 924}).status_code == 422


# ── policies ────────────────────────────────────────────────────────────────

def test_a_server_gets_the_server_policy_on_top_of_the_default(db):
    server = effective_policy(db, db.get(Device, 781))
    keys = {m.key: m for m in server.monitors}
    assert server.version == "1.1,2.5"
    assert keys["cpu"].threshold == 90  # the server policy overrides
    assert "mem" in keys and "disk_forecast" in keys  # inherited and added
    payload = agent_policy_payload(server)
    sent = {m["key"] for m in payload["monitors"]}
    assert "disk_forecast" not in sent and "no_data" not in sent  # evaluated by the platform


def test_a_group_policy_is_more_specific_than_a_client_one(db):
    device = db.get(Device, 924)
    device.group_id = 7
    db.add_all([
        MonitoringPolicy(id=3, name="TECHI", scope="client", scope_value="1", sample_seconds=60, upload_seconds=600,
                         monitors=[], updated_at=utcnow_naive()),
        MonitoringPolicy(id=4, name="Kiosks", scope="group", scope_value="7", sample_seconds=30, upload_seconds=300,
                         monitors=[], updated_at=utcnow_naive()),
    ])
    db.commit()
    mps.invalidate_cache()
    policy = effective_policy(db, device)
    assert policy.sample_seconds == 30 and policy.upload_seconds == 300
    assert policy.policies == ["Workstations", "TECHI", "Kiosks"]


def test_heartbeat_hands_the_policy_only_to_the_real_agent(db, monkeypatch):
    from unittest.mock import patch

    from app.api.v1.endpoints import agent as agent_endpoint
    from app.db.session import get_db

    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: _NoClose(db)
    app.include_router(agent_endpoint.router, prefix="/api/v1/agent")
    with patch("app.api.v1.endpoints.agent._heartbeat_side_effects"):
        client = TestClient(app)
        real = client.post("/api/v1/agent/heartbeat", json={"device_id": 924, "agent_id": AGENT, "hostname": "Mario-Lenovo", "platform": "windows"})
        forged = client.post("/api/v1/agent/heartbeat", json={"device_id": 924, "agent_id": "x", "hostname": "Mario-Lenovo", "platform": "windows"})
    assert real.json()["monitoring_policy"]["version"] == "1.1"
    assert real.json()["monitoring_policy"]["upload_seconds"] == 900
    assert forged.json()["monitoring_policy"] is None


# ── monitor alerts ──────────────────────────────────────────────────────────

def test_a_firing_monitor_opens_an_alert_and_ok_closes_it(db):
    device = db.get(Device, 924)
    policy = effective_policy(db, device)
    service = MonitorAlertService(db)
    service.apply(device, MonitorEvent(key="cpu", state="firing", value=97.2, threshold=95), policy)
    service.apply(device, MonitorEvent(key="cpu", state="firing", value=98.0, threshold=95), policy)  # repeated
    alerts = db.query(DeviceAlert).filter(DeviceAlert.kind == AlertKind.HIGH_CPU).all()
    assert len(alerts) == 1
    assert alerts[0].message == "CPU above 95% for 15 min on Mario-Lenovo (now 97%)"
    # Critical in the policy, but on a user PC: a warning (P3), not a page.
    assert alerts[0].severity.value == "warning" and alerts[0].priority == 3
    service.apply(device, MonitorEvent(key="cpu", state="ok"), policy)
    assert db.query(DeviceAlert).filter(DeviceAlert.state == AlertState.OPEN).count() == 0


def test_a_monitor_the_policy_no_longer_has_is_ignored(db):
    device = db.get(Device, 924)
    MonitorAlertService(db).apply(device, MonitorEvent(key="gone", state="firing", value=1), effective_policy(db, device))
    assert db.query(DeviceAlert).count() == 0


def test_the_heartbeat_does_not_alert_twice_for_an_agent_that_monitors_itself(db):
    from app.services.telemetry_ingest_service import devices_with_agent_monitoring

    _ingest(db, _minutes(utcnow_naive() - timedelta(minutes=5), 1))
    assert devices_with_agent_monitoring(db, {924, 600}) == {924}


def test_telemetry_that_stops_arriving_while_online_raises_an_alert(db):
    _ingest(db, _minutes(utcnow_naive() - timedelta(minutes=5), 1))
    state = db.get(DeviceTelemetryState, 924)
    state.last_upload_at = utcnow_naive() - timedelta(hours=1)
    db.commit()
    MonitorAlertService(db).sweep()
    alert = db.query(DeviceAlert).filter(DeviceAlert.kind == AlertKind.TELEMETRY_MISSING).one()
    assert "no data for 10 min while on" in alert.message


def test_a_disk_that_will_fill_within_the_threshold_raises_an_alert(db):
    base = (utcnow_naive() - timedelta(days=13)).replace(hour=10, minute=0, second=0, microsecond=0)
    for day in range(13):
        db.add(TelemetryRollup1h(device_id=781, bucket=base + timedelta(days=day), samples=60, expected=60,
                                 disks=[{"mount": "D:", "used_pct": 78 + day * 1.5, "free_gb": 60, "total_gb": 465}]))
    db.add(DeviceTelemetryState(device_id=781, last_seq=1, last_upload_at=utcnow_naive(), policy_version="1.1,2.5"))
    db.commit()
    (disk,) = disk_trends(db, 781)
    assert disk.mount == "D:" and 0 < disk.days_to_full < 14
    MonitorAlertService(db).sweep()
    alert = db.query(DeviceAlert).filter(DeviceAlert.kind == AlertKind.DISK_FORECAST).one()
    assert alert.message.startswith("Disk D: full within 14 days on HV-PROD-01")


# ── what the pages read ─────────────────────────────────────────────────────

def test_a_day_of_minutes_tells_device_off_from_missing_data(db):
    now = utcnow_naive().replace(second=0, microsecond=0)
    start = now - timedelta(hours=6)
    _ingest(db, _minutes(start, 60))  # on for an hour
    # off for two hours: the next sample's uptime says the PC booted since
    _ingest(db, _minutes(start + timedelta(hours=3), 30, first_seq=61, uptime0=120))
    # agent stopped for 20 minutes while the PC stayed up
    _ingest(db, _minutes(start + timedelta(hours=3, minutes=50), 30, first_seq=91, uptime0=120 + 50 * 60))
    metrics = MetricsQueryService(db).device_metrics(db.get(Device, 924), "24h")
    assert metrics.source == "agent" and metrics.resolution == "1m"
    assert len(metrics.points) == 120
    kinds = [s.kind for s in metrics.coverage.segments]
    # hours old when they arrived, so they came late from the buffer
    assert kinds == ["late", "off", "late", "missing", "late"]
    assert metrics.coverage.missing_minutes == 20 and metrics.coverage.off_minutes == 120
    assert metrics.delivery is not None and metrics.delivery.policy_current is True


def test_a_device_without_the_new_agent_is_charted_from_its_heartbeats(db):
    now = utcnow_naive()
    for i in range(12):
        db.add(DeviceTelemetry(device_id=600, cpu_percent=20 + i, ram_percent=50, disk_percent=70,
                               created_at=now - timedelta(minutes=5 * i)))
    db.commit()
    metrics = MetricsQueryService(db).device_metrics(db.get(Device, 600), "24h")
    assert metrics.source == "heartbeat" and len(metrics.points) == 12
    assert metrics.summary.cpu_peak == 31


def test_the_client_view_has_a_heatmap_trend_and_attention(db):
    start = utcnow_naive().replace(minute=0, second=0, microsecond=0) - timedelta(hours=3)
    _ingest(db, _minutes(start, 120, cpu=lambda i: 92.0))
    view = MetricsQueryService(db).client_monitoring(db.query(Device).all(), "7d")
    assert view.devices_total == 3 and view.one_minute_devices == 1
    row = next(r for r in view.heatmap if r.device_id == 924)
    assert len(row.cells) == 24 and row.peak == 92.0
    assert any(a.kind == "cpu_sustained" for a in view.attention) is False  # two hours only
    assert view.trend and view.coverage_pct == 100.0
    assert next(d for d in view.devices if d.device_id == 924).one_minute is True


def test_retention_keeps_seven_days_of_minutes(db):
    old = utcnow_naive() - timedelta(days=8)
    db.add(TelemetrySample(device_id=924, ts=old, seq=1, cpu=1))
    db.add(TelemetryRollup5m(device_id=924, bucket=utcnow_naive() - timedelta(days=31), samples=5, expected=5))
    db.commit()
    assert cleanup_telemetry_pipeline(db) == 2
    assert db.query(TelemetrySample).count() == 0


def test_a_device_in_the_servers_group_gets_the_server_policy_whatever_its_type_column(db):
    """HV-PROD-01: in the Servers group, device_type UNASSIGNED — it ran only
    the Workstations policy, so the disk forecast never applied to it."""
    from app.models.device_group import DeviceGroup

    db.add(DeviceGroup(id=5, name="Servers", client_id=1))
    db.add(Device(id=12, agent_id="agent_ts", hostname="Techi-Server", platform="windows", client_id=1,
                  group_id=5, device_type=DeviceType.UNASSIGNED, status=DeviceStatus.ONLINE,
                  last_seen=utcnow_naive()))
    db.commit()
    mps.invalidate_cache()
    policy = effective_policy(db, db.get(Device, 12))
    assert "Servers" in policy.policies and "disk_forecast" in {m.key for m in policy.monitors}


def test_coverage_counts_only_agents_that_report_their_policy(db):
    _ingest(db, _minutes(utcnow_naive() - timedelta(minutes=5), 1))  # 924 reports 1.1
    workstations = next(p for p in mps.MonitoringPolicyService(db).list() if p.name == "Workstations")
    assert (workstations.devices, workstations.devices_reporting, workstations.devices_current) == (3, 1, 1)


def test_a_device_type_policy_takes_a_category_and_the_old_values():
    from app.services.monitoring_policy_service import device_category_value

    assert device_category_value("server") == "servers" and device_category_value("client") == "clientpc"
    assert device_category_value("hypervisors") == "hypervisors"


def test_a_disk_already_full_is_at_risk_whether_or_not_it_grows(db):
    """TECHI shpk: Techi-Server C: at 96% (steady) and Sabina-PC at 91%
    (older agent) showed "Disks at risk 0"."""
    start = utcnow_naive().replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
    full = [{"mount": "C:", "used_pct": 96.0, "free_gb": 9.5, "total_gb": 238.0}]
    _ingest(db, _minutes(start, 90, disks=full))
    for i in range(6):
        db.add(DeviceTelemetry(device_id=600, cpu_percent=20, ram_percent=50, disk_percent=91,
                               created_at=utcnow_naive() - timedelta(minutes=10 * i)))
    db.commit()
    view = MetricsQueryService(db).client_monitoring(db.query(Device).all(), "7d")
    assert view.disks_at_risk == 2
    titles = {a.title: a.severity for a in view.attention if a.kind == "disk_forecast"}
    assert titles == {"Mario-Lenovo · C: 96% full": "critical", "Rudi-PC · disk 91% full": "warning"}
