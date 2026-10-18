"""Agent 2.1.33 monitoring: disk activity, network quality and top processes in
the 1-minute samples; the device health report (physical disks, pending
restart, critical events); the monitors and alerts built on them; restarts and
alerts drawn on the charts; small volumes left out of disk alerts; the
migration that adds it all."""
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow_naive
from app.db.base import Base
from app.models.alert import AlertKind, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.models.telemetry_pipeline import MonitoringPolicy, TelemetryRollup5m, TelemetrySample
from app.schemas.agent import AgentHeartbeatPayload
from app.schemas.device_health import DeviceHealth, parse_device_health
from app.schemas.telemetry_pipeline import Monitor, MonitorEvent, TelemetryUpload
from app.services import device_heartbeat_service
from app.services import monitoring_policy_service as mps
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.device_health import alerting_events, merge_health, reboot_pending_days
from app.services.metrics_query_service import MetricsQueryService, disk_trends
from app.services.monitor_alert_service import MonitorAlertService, describe
from app.services.monitoring_policy_service import agent_policy_payload, effective_policy
from app.services.telemetry_ingest_service import TelemetryIngestService

AGENT = "agent_HEALTH_0123456789ab"

DEFAULT = [
    {"key": "disk", "metric": "disk", "op": ">", "threshold": 90, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "security", "metric": "security_score", "op": "<", "threshold": 70, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "disk_health", "metric": "disk_health", "op": ">", "threshold": 0, "duration_s": 0, "severity": "critical", "enabled": True},
    {"key": "critical_events", "metric": "critical_events", "op": ">", "threshold": 0, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "reboot_pending", "metric": "reboot_pending_days", "op": ">", "threshold": 7, "duration_s": 0, "severity": "info", "enabled": True},
    {"key": "disk_busy", "metric": "disk_busy", "op": ">", "threshold": 90, "duration_s": 1200, "severity": "info", "enabled": True},
    {"key": "gw_loss", "metric": "gw_loss", "op": ">", "threshold": 20, "duration_s": 600, "severity": "warning", "enabled": True},
    {"key": "net_rx", "metric": "net_rx_mbps", "op": ">", "threshold": 800, "duration_s": 300, "severity": "info", "enabled": False},
]
SERVICES = {"key": "services", "metric": "service", "op": ">", "threshold": 0, "duration_s": 300, "severity": "critical",
            "enabled": True, "target": "MSSQL*, vmms"}


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
    session.add(Client(id=1, name="TECHI shpk", slug="techi"))
    session.add_all([
        MonitoringPolicy(id=1, name="Workstations", scope="default", monitors=DEFAULT, version=1, updated_at=utcnow_naive()),
        MonitoringPolicy(id=2, name="Servers", scope="device_type", scope_value="servers", monitors=[SERVICES], version=1,
                         updated_at=utcnow_naive()),
    ])
    session.add_all([
        Device(id=924, agent_id=AGENT, hostname="Mario-Lenovo", platform="windows", client_id=1, rustdesk_id="123456789",
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow_naive(), agent_version="2.1.33"),
        Device(id=781, agent_id="agent_srv", hostname="HV-PROD-01", platform="windows", client_id=1,
               device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE, last_seen=utcnow_naive(), agent_version="2.1.31"),
    ])
    session.commit()
    mps.invalidate_cache()
    yield session
    session.close()
    mps.invalidate_cache()


def _minute(i, start, **fields):
    sample = {"seq": i + 1, "ts": (start + timedelta(minutes=i)).isoformat() + "Z", "cpu": 10.0, "mem": 40.0,
              "uptime_s": 7200 + 60 * i,
              "disks": [{"mount": "C:", "used_pct": 54.0, "free_gb": 108.5, "total_gb": 238.0}]}
    sample.update(fields)
    return sample


def _ingest(db, samples, device_id=924):
    device = db.get(Device, device_id)
    upload = TelemetryUpload.model_validate({"device_id": device_id, "agent_id": device.agent_id, "policy_version": "1.1",
                                             "sample_seconds": 60, "samples": samples})
    return TelemetryIngestService(db).ingest(device, upload, effective_policy(db, device))


def _health(**overrides):
    now = datetime.now(timezone.utc)
    base = {
        "collected_at": now.isoformat(),
        "disks": [{"name": "Samsung SSD 870 EVO 500GB", "media": "SSD", "bus": "SATA", "size_gb": 465.8,
                   "health": "Healthy", "operational": ["OK"], "predict_failure": False, "temperature_c": 34,
                   "wear_pct": 3, "power_on_hours": 8123, "read_errors": 0, "write_errors": 0}],
        "reboot_pending": False,
        "reboot_reasons": [],
        "events": [],
    }
    base.update(overrides)
    return base


def _event(record, source, event_id, hours_ago, message="x"):
    at = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    return {"record_id": record, "source": source, "event_id": event_id, "at": at.isoformat(), "message": message}


def _beat(db, **fields):
    payload = AgentHeartbeatPayload(hostname="Mario-Lenovo", platform="windows", rustdesk_id="123456789", **fields)
    DeviceHeartbeatService(db).process_heartbeat(payload)


def _open(db, kind):
    db.expire_all()
    return db.query(DeviceAlert).filter(DeviceAlert.kind == kind, DeviceAlert.state == AlertState.OPEN).all()


# ── samples ─────────────────────────────────────────────────────────────────

def test_disk_activity_network_quality_and_top_processes_are_stored_and_rolled_up(db):
    start = (utcnow_naive() - timedelta(minutes=40)).replace(minute=0, second=0, microsecond=0) \
        if utcnow_naive().minute >= 40 else (utcnow_naive() - timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    samples = [
        _minute(0, start, disk_busy=20, disk_queue=0.4, disk_read_bps=1e6, disk_write_bps=2e6, gw_ms=2, gw_loss=0, wan_ms=31),
        _minute(1, start, cpu=88.0, disk_busy=97, disk_queue=3.1, disk_read_bps=5e7, disk_write_bps=1e6, gw_ms=4, gw_loss=25,
                wan_ms=35, top=[{"n": "MsMpEng.exe", "c": 61.2, "m": 310}, {"n": "chrome.exe", "c": 12.0, "m": 1800}]),
        _minute(2, start, cpu=40.0, disk_busy=60, gw_ms=3, gw_loss=0, wan_ms=33,
                top=[{"n": "chrome.exe", "c": 30.0, "m": 2100}]),
    ]
    assert _ingest(db, samples).stored == 3
    row = db.query(TelemetrySample).filter(TelemetrySample.cpu == 88.0).one()
    assert row.disk_busy == 97 and row.gw_loss == 25 and row.top[0] == {"n": "MsMpEng.exe", "c": 61.2, "m": 310.0}
    bucket = db.query(TelemetryRollup5m).one()
    assert bucket.disk_busy_avg == pytest.approx(59.0) and bucket.disk_busy_max == 97
    assert bucket.gw_loss_max == 25 and bucket.wan_ms_avg == pytest.approx(33.0)
    assert bucket.top[0]["n"] == "MsMpEng.exe"  # the busiest minute's

    metrics = MetricsQueryService(db).device_metrics(db.get(Device, 924), "24h")
    busy = next(p for p in metrics.points if p.cpu_avg == 88.0)
    assert busy.disk_busy_avg == 97 and busy.gw_loss_avg == 25 and busy.top[0].n == "MsMpEng.exe"
    assert metrics.summary.disk_busy_peak == 97 and metrics.summary.gw_loss_avg == pytest.approx(8.3, abs=0.1)
    names = [p.name for p in metrics.processes]
    assert names[0] == "MsMpEng.exe" and "chrome.exe" in names
    chrome = next(p for p in metrics.processes if p.name == "chrome.exe")
    assert chrome.minutes == 2 and chrome.cpu_peak == 30.0 and chrome.mem_peak_mb == 2100

    week = MetricsQueryService(db).device_metrics(db.get(Device, 924), "7d")
    assert week.points[0].disk_busy_max == 97 and week.points[0].top[0].n == "MsMpEng.exe"


def test_an_older_agent_upload_without_the_new_fields_still_works(db):
    start = utcnow_naive().replace(second=0, microsecond=0) - timedelta(minutes=10)
    assert _ingest(db, [_minute(0, start)]).stored == 1
    metrics = MetricsQueryService(db).device_metrics(db.get(Device, 924), "1h")
    assert metrics.points[0].disk_busy_avg is None and metrics.points[0].top is None
    assert metrics.processes == []


def test_restarts_are_read_from_the_uptime_and_alerts_are_returned_for_the_charts(db):
    now = utcnow_naive().replace(second=0, microsecond=0)
    start = now - timedelta(hours=5)
    samples = [dict(_minute(i, start), uptime_s=3 * 86400 + 60 * i) for i in range(30)]  # up for 3 days
    # rebooted two hours later: uptime starts over
    later = start + timedelta(hours=2)
    samples += [dict(_minute(i, later), seq=100 + i, uptime_s=90 + 60 * i) for i in range(30)]
    _ingest(db, samples)
    db.add(DeviceAlert(device_id=924, kind=AlertKind.HIGH_CPU, severity="critical", state=AlertState.RESOLVED,
                       message="CPU above 95% for 15 min", created_at=now - timedelta(hours=4),
                       updated_at=now, resolved_at=now - timedelta(hours=3, minutes=30)))
    db.add(DeviceAlert(device_id=924, kind=AlertKind.HIGH_CPU, severity="critical", state=AlertState.RESOLVED,
                       message="long ago", created_at=now - timedelta(days=3), updated_at=now,
                       resolved_at=now - timedelta(days=2)))
    db.commit()
    metrics = MetricsQueryService(db).device_metrics(db.get(Device, 924), "24h")
    assert len(metrics.restarts) == 1
    assert abs(metrics.restarts[0] - (later - timedelta(seconds=90))) < timedelta(seconds=5)
    assert [a.message for a in metrics.alerts] == ["CPU above 95% for 15 min"]
    assert metrics.alerts[0].kind == "high_cpu" and metrics.alerts[0].end is not None


# ── small volumes ───────────────────────────────────────────────────────────

def test_a_small_volume_is_shown_but_raises_no_disk_alert(db):
    disks = [{"mount": "C:", "used_pct": 54.0, "free_gb": 108.5, "total_gb": 238.0},
             {"mount": "D:", "used_pct": 89.0, "free_gb": 0.1, "total_gb": 1.0}]
    _ingest(db, [_minute(0, utcnow_naive() - timedelta(minutes=5), disks=disks)])
    trends = {d.mount: d for d in disk_trends(db, 924)}
    assert trends["C:"].monitored and not trends["D:"].monitored
    assert db.query(TelemetryRollup5m).one().disk_max == 54.0

    device = db.get(Device, 924)
    service = MonitorAlertService(db)
    service.apply(device, MonitorEvent(key="disk", state="firing", value=89, threshold=90, target="D:"), effective_policy(db, device))
    assert _open(db, AlertKind.LOW_DISK) == []
    service.apply(device, MonitorEvent(key="disk", state="firing", value=93, threshold=90, target="C:"), effective_policy(db, device))
    assert len(_open(db, AlertKind.LOW_DISK)) == 1


# ── the health report ───────────────────────────────────────────────────────

def test_a_health_report_keeps_only_known_events_and_bounded_values():
    health = parse_device_health(_health(
        disks=[{"name": "  WDC WD10EZEX  ", "health": "Unhealthy", "temperature_c": 0, "wear_pct": 140, "size_gb": "big",
                "operational": ["Predictive Failure", "OK"], "predict_failure": "yes"}],
        reboot_pending=True, reboot_reasons=["windows_update", "nonsense", "windows_update"],
        events=[_event(1, "Microsoft-Windows-Kernel-Power", 41, 3), _event(2, "Some-App", 1000, 2),
                _event(3, "disk", 7, 1, message="  The device \\Device\\Harddisk0\\DR0 has a bad block.  ")],
    ))
    disk = health.disks[0]
    assert disk.name == "WDC WD10EZEX" and disk.health == "unhealthy"
    assert disk.temperature_c is None and disk.wear_pct is None and disk.size_gb is None and disk.predict_failure is None
    assert disk.operational == "Predictive Failure, OK" and disk.problem == "Unhealthy"
    assert health.reboot_reasons == ["windows_update"]
    assert [(e.source, e.category, e.title) for e in health.events] == [
        ("Microsoft-Windows-Kernel-Power", "crash", "Restarted without a clean shutdown"),
        ("disk", "disk", "Bad block on a disk"),
    ]
    assert health.events[1].message.startswith("The device")
    assert parse_device_health("nope") is None


def test_events_are_kept_for_a_week_and_a_pending_restart_is_dated_from_its_first_report():
    now = datetime.now(timezone.utc)
    first = merge_health(None, parse_device_health(_health(
        reboot_pending=True, reboot_reasons=["windows_update"],
        events=[_event(1, "Microsoft-Windows-Kernel-Power", 41, 20), _event(9, "EventLog", 6008, 24 * 8)],
    )), now - timedelta(days=9))
    # the agent's 25-hour window moved on: event 1 is no longer in the report
    second = merge_health(first, parse_device_health(_health(
        reboot_pending=True, reboot_reasons=["windows_update"], events=[_event(2, "BugCheck", 1001, 1)],
    )), now)
    assert [e.record_id for e in second.events] == [2, 1]  # the 8-day-old one dropped, newest first
    assert second.reboot_pending_since == first.reboot_pending_since
    assert reboot_pending_days(second, now) == pytest.approx(9, abs=0.01)
    assert len(alerting_events(second, now)) == 2

    cleared = merge_health(second, parse_device_health(_health(reboot_pending=False)), now)
    assert cleared.reboot_pending_since is None and reboot_pending_days(cleared, now) is None
    routine = merge_health(None, parse_device_health(_health(reboot_pending=True, reboot_reasons=["file_rename"])), now)
    assert reboot_pending_days(routine, now) is None  # an installer's file rename is not worth an alert


def test_the_devices_own_agent_stores_its_health_and_the_monitors_judge_it(db):
    _beat(db, agent_id=AGENT, device_health=_health(
        disks=[{"name": "ST1000DM003", "media": "HDD", "health": "Warning", "predict_failure": True}],
        events=[_event(11, "Microsoft-Windows-WER-SystemErrorReporting", 1001, 2, "The computer has rebooted from a bugcheck.")],
    ))
    row = db.query(DeviceInventory).filter(DeviceInventory.device_id == 924).one()
    assert DeviceHealth.model_validate_json(row.health_json).disks[0].predict_failure is True
    (disk_alert,) = _open(db, AlertKind.DISK_HEALTH)
    assert disk_alert.message == "Disk health: ST1000DM003 — SMART predicts failure on Mario-Lenovo"
    assert disk_alert.severity.value == "critical"
    (events_alert,) = _open(db, AlertKind.CRITICAL_EVENTS)
    assert events_alert.message == "1 critical event in 24 h on Mario-Lenovo: Blue screen (stop error)"

    # a forged heartbeat cannot clear it
    _beat(db, agent_id="someone-else", device_id=924, device_health=_health())
    assert len(_open(db, AlertKind.DISK_HEALTH)) == 1
    # the next real report: disk replaced
    _beat(db, agent_id=AGENT, device_health=_health())
    assert _open(db, AlertKind.DISK_HEALTH) == []
    assert len(_open(db, AlertKind.CRITICAL_EVENTS)) == 1  # the blue screen is still within 24 h


def test_a_restart_pending_over_a_week_raises_an_alert(db):
    device = db.get(Device, 924)
    stored = _health(reboot_pending=True, reboot_reasons=["cbs"],
                     reboot_pending_since=(datetime.now(timezone.utc) - timedelta(days=9)).isoformat())
    db.add(DeviceInventory(device_id=924, health_json=json.dumps(stored), collected_at=utcnow_naive()))
    db.commit()
    MonitorAlertService(db).evaluate_reports(device)
    (alert,) = _open(db, AlertKind.REBOOT_PENDING)
    assert alert.message == "Restart pending for 9 days on Mario-Lenovo"
    assert "Component servicing" in alert.detail


def test_a_low_security_score_raises_an_alert_with_the_findings(db):
    posture = {"defender": {"present": True, "antivirus_enabled": False}, "firewall": {"domain": True, "private": False, "public": True}}
    _beat(db, agent_id=AGENT, security_posture=posture)
    (alert,) = _open(db, AlertKind.SECURITY_POSTURE)
    assert alert.message == "Security score below 70 on Mario-Lenovo (now 50)"
    assert "No active antivirus" in alert.detail and "Firewall off: private" in alert.detail


# ── services ────────────────────────────────────────────────────────────────

def test_a_service_monitor_needs_valid_names_and_reaches_the_agent_with_them(db):
    with pytest.raises(ValidationError):
        Monitor(key="svc", metric="service", threshold=0)
    with pytest.raises(ValidationError):
        Monitor(key="svc", metric="service", threshold=0, target="ok, bad;name")
    server = db.get(Device, 781)
    server.group_id = None
    policy = effective_policy(db, server)
    payload = agent_policy_payload(policy)
    sent = {m["key"]: m for m in payload["monitors"]}
    assert sent["services"]["target"] == "MSSQL*, vmms"
    assert {"security", "disk_health", "critical_events", "reboot_pending"}.isdisjoint(sent)  # judged by the platform
    assert "disk_busy" in sent and "gw_loss" in sent
    assert describe(Monitor.model_validate(SERVICES)) == "stopped for 5 min · MSSQL*, vmms"


def test_a_stopped_service_opens_one_alert_naming_it(db):
    server = db.get(Device, 781)
    service = MonitorAlertService(db)
    policy = effective_policy(db, server)
    service.apply(server, MonitorEvent(key="services", state="firing", value=1, target="MSSQL$SAGE"), policy)
    service.apply(server, MonitorEvent(key="services", state="firing", value=2, target="MSSQL$SAGE, vmms"), policy)
    (alert,) = db.query(DeviceAlert).filter(DeviceAlert.kind == AlertKind.SERVICE_STOPPED).all()
    assert alert.message == "Service stopped for 5 min on HV-PROD-01: MSSQL$SAGE"
    service.apply(server, MonitorEvent(key="services", state="ok"), policy)
    assert _open(db, AlertKind.SERVICE_STOPPED) == []


# ── the Monitoring tab ──────────────────────────────────────────────────────

def test_monitor_states_say_off_needs_agent_and_show_the_health_report(db):
    _ingest(db, [_minute(0, utcnow_naive() - timedelta(minutes=3), disk_busy=35.0, gw_loss=0.0)])
    _beat(db, agent_id=AGENT, device_health=_health(reboot_pending=True, reboot_reasons=["windows_update"]))
    monitoring = MetricsQueryService(db).device_monitoring(db.get(Device, 924))
    states = {m.key: (m.state, m.now) for m in monitoring.monitors}
    assert states["net_rx"][0] == "off"
    assert states["disk_busy"] == ("ok", "now 35%")
    assert states["disk_health"] == ("ok", "1 disk healthy")
    assert states["critical_events"] == ("ok", "none in 24 h")
    assert states["reboot_pending"] == ("ok", "pending today")
    assert states["security"] == ("unknown", "needs agent 2.1.31")
    assert monitoring.health.disks[0].name == "Samsung SSD 870 EVO 500GB"
    assert monitoring.health.reboot_reasons == ["Windows Update"]

    older = MetricsQueryService(db).device_monitoring(db.get(Device, 781))
    server_states = {m.key: (m.state, m.now) for m in older.monitors}
    assert server_states["services"] == ("unknown", "needs agent 2.1.33")
    assert server_states["disk_health"] == ("unknown", "needs agent 2.1.33")
    assert older.health is None


# ── migration ───────────────────────────────────────────────────────────────

MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "t8u9v0w1x2y3_device_health_monitoring.py"


def _migration():
    spec = importlib.util.spec_from_file_location("health_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_migration_adds_columns_and_monitors_once_and_its_downgrade_takes_them_out():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE telemetry_samples (device_id INTEGER, ts DATETIME, cpu FLOAT)"))
        conn.execute(sa.text("CREATE TABLE telemetry_rollup_5m (device_id INTEGER, bucket DATETIME)"))
        conn.execute(sa.text("CREATE TABLE telemetry_rollup_1h (device_id INTEGER, bucket DATETIME)"))
        conn.execute(sa.text("CREATE TABLE device_inventory (id INTEGER PRIMARY KEY, device_id INTEGER)"))
        conn.execute(sa.text(
            "CREATE TABLE monitoring_policies (id INTEGER PRIMARY KEY, scope VARCHAR(16), scope_value VARCHAR(64), "
            "monitors JSON, version INTEGER, updated_at DATETIME, updated_by VARCHAR(120))"
        ))
        mine = [{"key": "security", "metric": "security_score", "op": "<", "threshold": 50, "duration_s": 0,
                 "severity": "critical", "enabled": True},
                {"key": "cpu", "metric": "cpu", "op": ">", "threshold": 95, "duration_s": 900, "severity": "critical", "enabled": True}]
        conn.execute(sa.text("INSERT INTO monitoring_policies VALUES (1, 'default', NULL, :m, 3, NULL, 'denis')"),
                     {"m": json.dumps(mine)})
        conn.execute(sa.text("INSERT INTO monitoring_policies VALUES (2, 'device_type', 'server', '[]', 7, NULL, 'denis')"))
        conn.execute(sa.text("INSERT INTO monitoring_policies VALUES (3, 'client', '4', '[]', 1, NULL, 'denis')"))

    def run(step):
        with engine.begin() as conn:
            with Operations.context(MigrationContext.configure(conn)):
                getattr(_migration(), step)()

    def policies():
        with engine.connect() as conn:
            return {r.id: (json.loads(r.monitors), r.version) for r in conn.execute(sa.text("SELECT * FROM monitoring_policies"))}

    run("upgrade")
    columns = {c["name"] for c in sa.inspect(engine).get_columns("telemetry_samples")}
    assert {"disk_busy", "gw_loss", "wan_ms", "top"} <= columns
    assert {"health_json", "health_collected_at"} <= {c["name"] for c in sa.inspect(engine).get_columns("device_inventory")}
    after = policies()
    default = {m["key"]: m for m in after[1][0]}
    assert default["security"]["threshold"] == 50  # the owner's own monitor is kept
    assert {"disk_health", "critical_events", "reboot_pending", "disk_busy", "gw_loss", "gw_latency"} <= set(default)
    assert after[1][1] == 4
    assert after[2][0][0]["metric"] == "service" and "MSSQL*" in after[2][0][0]["target"] and after[2][1] == 8
    assert after[3] == ([], 1)
    for m in after[1][0] + after[2][0]:
        Monitor.model_validate(m)

    run("downgrade")
    restored = policies()
    assert [m["key"] for m in restored[1][0]] == ["cpu"]
    assert restored[2][0] == []
    assert "disk_busy" not in {c["name"] for c in sa.inspect(engine).get_columns("telemetry_samples")}
