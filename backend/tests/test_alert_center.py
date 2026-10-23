"""The Alerts work queue (alert center): event rules that cut noise, one alert
per problem that reopens counted, priority by device role, owner, snooze,
resolve with a reason, mute rules, the alert panel, findings, the quality
report, site outages, the P1 reminder and the AI analysis (with Claude
mocked: nothing leaves the test)."""
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import alerts as alerts_endpoint
from app.core.auth import get_current_operator, get_operator_scope
from app.core.config import settings
from app.core.time import utcnow_naive
from app.db.base import Base
from app.db.session import get_db
from app.models.alert import AlertActivity, AlertAnalysis, AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.client_location import ClientLocation
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.models.operator import Operator
from app.models.telemetry_pipeline import MonitoringPolicy
from app.schemas.device_health import parse_device_health
from app.services import alert_ai_service
from app.services import monitoring_policy_service as mps
from app.services.alert_ai_service import AlertAIService, Redactor, checked_risk
from app.services.alert_center_service import AlertCenterService
from app.services.alert_engine import AlertEngine
from app.services.alert_presenter import describe_alert
from app.services.alert_rules import priority_for
from app.services.alert_runbooks import RUNBOOKS, runbook_for
from app.services.device_health import firing_event_groups, is_actionable
from app.services.monitor_alert_service import MonitorAlertService

POLICY = [
    {"key": "critical_events", "metric": "critical_events", "op": ">", "threshold": 0, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "security", "metric": "security_score", "op": "<", "threshold": 70, "duration_s": 0, "severity": "warning", "enabled": True},
]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Client(id=1, name="Vasgroup", slug="vasgroup"))
    session.add(ClientLocation(id=5, client_id=1, name="Durrës office", country="AL", city="Durrës"))
    session.add(MonitoringPolicy(id=1, name="Default", scope="default", monitors=POLICY, version=1, updated_at=utcnow_naive()))
    session.add_all([
        Device(id=1, hostname="RECEPTION-08", platform="windows", client_id=1, rustdesk_id="1", current_user="ana.k",
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE, last_seen=utcnow_naive(), public_ip="91.92.1.2"),
        Device(id=2, hostname="SRV-FILE-02", platform="windows", client_id=1, rustdesk_id="2",
               device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE, last_seen=utcnow_naive()),
    ])
    session.add_all([
        Operator(id=1, username="denis", email="d@x.al", hashed_password="x", role="admin"),
        Operator(id=2, username="mario", email="m@x.al", hashed_password="x", role="operator"),
    ])
    session.commit()
    mps.invalidate_cache()
    yield session
    session.close()
    mps.invalidate_cache()


def _event(record, source, event_id, hours_ago, message="x", win_level=None):
    at = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    event = {"record_id": record, "source": source, "event_id": event_id, "at": at.isoformat(), "message": message}
    if win_level is not None:
        event["win_level"] = win_level
    return event


def _health(events):
    return parse_device_health({"disks": [], "reboot_pending": False, "reboot_reasons": [], "events": events})


def _store_health(db, device_id, events):
    db.add(DeviceInventory(device_id=device_id, health_json=_health(events).model_dump_json(), collected_at=utcnow_naive()))
    db.commit()


def _open(db, kind=None):
    query = db.query(DeviceAlert).filter(DeviceAlert.state == AlertState.OPEN)
    if kind is not None:
        query = query.filter(DeviceAlert.kind == kind)
    return query.all()


HEALTHY_98 = "Volume C: (\\Device\\HarddiskVolume3) is healthy. No action is needed."
BROKEN_98 = ("Volume C: (\\Device\\HarddiskVolume3) needs to be taken offline to perform a Full Chkdsk. "
             'Please run "CHKDSK /F" locally via the command line, or run "REPAIR-VOLUME <drive:>" locally or remotely via PowerShell.')


# ── the noise rules ─────────────────────────────────────────────────────────

def test_ntfs_98_counts_only_when_it_asks_for_a_repair():
    healthy = _health([_event(1, "Microsoft-Windows-Ntfs", 98, 1, HEALTHY_98)]).events[0]
    broken = _health([_event(2, "Microsoft-Windows-Ntfs", 98, 1, BROKEN_98)]).events[0]
    italian = _health([_event(3, "Microsoft-Windows-Ntfs", 98, 1, "Il volume C: è integro. Nessuna azione necessaria.")]).events[0]
    assert not is_actionable(healthy) and not is_actionable(italian)
    assert is_actionable(broken)
    info_level = _health([_event(4, "EventLog", 6008, 1, "x", win_level=4)]).events[0]
    assert not is_actionable(info_level)  # agents >= 2.1.34 send the level


def test_one_unexpected_shutdown_on_a_pc_is_quiet_two_in_a_week_alert():
    now = datetime.now(timezone.utc)
    once = _health([_event(1, "Microsoft-Windows-Kernel-Power", 41, 2), _event(2, "EventLog", 6008, 2)])
    assert firing_event_groups(once, now, is_server=False) == []  # 41 + 6008 of one boot: one shutdown
    [server] = firing_event_groups(once, now, is_server=True)
    assert server.key == "shutdown" and server.count == 1

    twice = _health([_event(1, "Microsoft-Windows-Kernel-Power", 41, 2), _event(2, "EventLog", 6008, 2),
                     _event(3, "Microsoft-Windows-Kernel-Power", 41, 70)])
    [pc] = firing_event_groups(twice, now, is_server=False)
    assert pc.count == 2 and pc.window_h == 24 * 7

    old = _health([_event(1, "Microsoft-Windows-Kernel-Power", 41, 30), _event(3, "Microsoft-Windows-Kernel-Power", 41, 70)])
    assert firing_event_groups(old, now, is_server=False) == []  # nothing new in the last day


def test_event_groups_have_their_own_severity():
    now = datetime.now(timezone.utc)
    health = _health([
        _event(1, "Microsoft-Windows-WHEA-Logger", 18, 1),
        _event(2, "disk", 153, 1), _event(3, "disk", 153, 2),
        _event(4, "BugCheck", 1001, 3),
    ])
    groups = {g.key: g.severity for g in firing_event_groups(health, now, is_server=False)}
    assert groups == {"hardware": "critical", "bsod": "warning"}  # two I/O retries are below 3
    health = _health([_event(i, "disk", 153, i) for i in range(1, 4)])
    assert [g.key for g in firing_event_groups(health, now, is_server=False)] == ["disk_retry"]
    bsod_on_server = _health([_event(4, "BugCheck", 1001, 3)])
    assert firing_event_groups(bsod_on_server, now, is_server=True)[0].severity == "critical"


def test_reports_open_one_alert_per_group_and_close_the_rest(db):
    _store_health(db, 2, [_event(1, "Microsoft-Windows-Ntfs", 98, 1, HEALTHY_98),
                          _event(2, "Microsoft-Windows-Kernel-Power", 41, 1),
                          _event(3, "disk", 7, 1, "The device has a bad block.")])
    server = db.get(Device, 2)
    MonitorAlertService(db).evaluate_reports(server)
    alerts = {a.fingerprint: a for a in _open(db, AlertKind.CRITICAL_EVENTS)}
    assert set(alerts) == {"evt:shutdown", "evt:disk_bad"}  # the healthy NTFS 98 opened nothing
    assert alerts["evt:disk_bad"].priority == 1 and alerts["evt:shutdown"].priority == 2

    db.query(DeviceInventory).delete()
    _store_health(db, 2, [_event(3, "disk", 7, 1, "The device has a bad block.")])
    MonitorAlertService(db).evaluate_reports(server)
    assert [a.fingerprint for a in _open(db, AlertKind.CRITICAL_EVENTS)] == ["evt:disk_bad"]


def test_a_pc_that_keeps_losing_power_is_a_finding_not_an_alert(db, monkeypatch):
    shutdowns = [_event(1, "Microsoft-Windows-Kernel-Power", 41, 2), _event(2, "Microsoft-Windows-Kernel-Power", 41, 50)]
    _store_health(db, 1, shutdowns)
    MonitorAlertService(db).evaluate_reports(db.get(Device, 1))
    assert _open(db, AlertKind.CRITICAL_EVENTS) == []

    page = _api(db, monkeypatch).get("/api/v1/alerts/findings?type=power").json()
    [finding] = page["items"]
    assert finding["device_id"] == 1 and finding["title"] == "Unexpected shutdown 2× in 7 days"

    db.query(DeviceInventory).delete()
    _store_health(db, 2, shutdowns[:1])
    MonitorAlertService(db).evaluate_reports(db.get(Device, 2))
    assert [a.fingerprint for a in _open(db, AlertKind.CRITICAL_EVENTS)] == ["evt:shutdown"]  # a server still alerts


# ── priority, reopening, mutes ──────────────────────────────────────────────

def test_priority_weighs_the_device_role_and_recurrence():
    assert priority_for(AlertSeverity.CRITICAL, True) == 1
    assert priority_for(AlertSeverity.CRITICAL, False) == 2
    assert priority_for(AlertSeverity.WARNING, False) == 3
    assert priority_for(AlertSeverity.WARNING, False, occurrences=3) == 2
    assert priority_for(AlertSeverity.INFO, True, occurrences=9) == 4


def test_a_problem_that_comes_back_within_a_day_reopens_its_row(db):
    engine = AlertEngine(db)
    pc = db.get(Device, 1)
    first = engine._open_alert(1, AlertKind.HIGH_RAM, AlertSeverity.WARNING, "RAM high on RECEPTION-08", device=pc)
    engine.resolve_alert(first, reason="ram_normalized", cooldown_seconds=0)
    again = engine._open_alert(1, AlertKind.HIGH_RAM, AlertSeverity.WARNING, "RAM high on RECEPTION-08", device=pc)
    assert again.id == first.id and again.occurrences == 2 and again.state == AlertState.OPEN
    assert db.query(DeviceAlert).count() == 1
    actions = [a.action for a in db.query(AlertActivity).order_by(AlertActivity.id)]
    assert actions == ["opened", "resolved", "reopened"]


def test_a_worse_severity_wakes_a_snooze_until_worse(db):
    engine = AlertEngine(db)
    srv = db.get(Device, 2)
    alert = engine._open_alert(2, AlertKind.LOW_DISK, AlertSeverity.WARNING, "Disk D: 88%", device=srv, fingerprint="vol:D:")
    AlertCenterService(db).snooze(alert.id, None, SimpleNamespace(id=1, username="denis"), minutes=None, until=None, until_worse=True)
    engine._open_alert(2, AlertKind.LOW_DISK, AlertSeverity.CRITICAL, "Disk D: 96%", device=srv, fingerprint="vol:D:")
    db.refresh(alert)
    assert alert.severity == AlertSeverity.CRITICAL and alert.priority == 1
    assert alert.snoozed_until is None


def test_a_mute_rule_keeps_alerts_closed(db):
    center = AlertCenterService(db)
    engine = AlertEngine(db)
    pc = db.get(Device, 1)
    engine._open_alert(1, AlertKind.HIGH_CPU, AlertSeverity.WARNING, "CPU high", device=pc)
    body = SimpleNamespace(device_id=1, client_id=None, kind="high_cpu", fingerprint=None, days=7,
                           reason="Rendering PC, always busy", resolve_open=True)
    row = center.create_mute(None, SimpleNamespace(id=1, username="denis"), body)
    assert row["closed"] == 1 and _open(db) == []
    assert AlertEngine(db)._open_alert(1, AlertKind.HIGH_CPU, AlertSeverity.WARNING, "CPU high", device=pc) is None
    # another device is not muted
    assert AlertEngine(db)._open_alert(2, AlertKind.HIGH_CPU, AlertSeverity.WARNING, "CPU high", device=db.get(Device, 2))


# ── the API ─────────────────────────────────────────────────────────────────

def _api(db, monkeypatch, operator_id=1, scope=None):
    monkeypatch.setattr(alerts_endpoint, "build_token_usage_alerts", lambda _db: [])
    app = FastAPI()
    app.include_router(alerts_endpoint.router, prefix="/api/v1/alerts")
    operator = db.get(Operator, operator_id)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.dependency_overrides[get_operator_scope] = lambda: scope
    return TestClient(app)


def _seed_queue(db):
    engine = AlertEngine(db)
    p1 = engine._open_alert(2, AlertKind.SERVICE_STOPPED, AlertSeverity.CRITICAL, "Service stopped on SRV-FILE-02: Veeam",
                            device=db.get(Device, 2), fingerprint="svc:veeam")
    p3 = engine._open_alert(1, AlertKind.HIGH_CPU, AlertSeverity.WARNING, "CPU above 95% for 15 min on RECEPTION-08 (now 98%)",
                            device=db.get(Device, 1))
    return p1, p3


def test_the_queue_orders_by_priority_and_needs_action_hides_what_others_own(db, monkeypatch):
    p1, p3 = _seed_queue(db)
    api = _api(db, monkeypatch)
    page = api.get("/api/v1/alerts/queue", params={"view": "open"}).json()
    assert [a["id"] for a in page["items"]] == [p1.id, p3.id] and page["total"] == 2
    cpu = page["items"][1]
    assert cpu["title"] == "High CPU" and cpu["value"] == "98%" and cpu["device_role"] == "pc"
    assert [a["id"] for a in api.get("/api/v1/alerts/queue").json()["items"]] == [p1.id]  # needs_action: P1–P2

    mario = _api(db, monkeypatch, operator_id=2)
    assert mario.post(f"/api/v1/alerts/{p1.id}/take").json()["assigned_to_name"] == "mario"
    assert api.get("/api/v1/alerts/queue").json()["items"] == []  # Mario has it
    assert [a["id"] for a in mario.get("/api/v1/alerts/queue", params={"view": "mine"}).json()["items"]] == [p1.id]
    counts = api.get("/api/v1/alerts/count").json()
    assert counts["views"] == {"needs_action": 0, "mine": 0, "open": 2, "snoozed": 0}
    assert counts["by_priority"] == {"1": 1, "3": 1}


def test_snooze_resolve_with_reason_notes_and_the_panel(db, monkeypatch):
    p1, p3 = _seed_queue(db)
    api = _api(db, monkeypatch)
    assert api.post(f"/api/v1/alerts/{p3.id}/snooze", json={"minutes": 60}).status_code == 200
    assert [a["id"] for a in api.get("/api/v1/alerts/queue", params={"view": "snoozed"}).json()["items"]] == [p3.id]
    assert api.post(f"/api/v1/alerts/{p1.id}/notes", json={"text": "Called the client"}).status_code == 204
    resolved = api.put(f"/api/v1/alerts/{p1.id}/resolve", json={"resolution": "fixed", "note": "Restarted the service"}).json()
    assert resolved["resolution"] == "fixed" and resolved["resolved_by"] == "denis"

    detail = api.get(f"/api/v1/alerts/{p1.id}").json()
    assert detail["runbook"]["key"] == "service_stopped"
    assert [a["action"] for a in detail["activity"]][:2] == ["resolved", "note"]
    assert detail["facts"]["role"] == "server"
    assert detail["description"].startswith("Service stopped · Veeam on this server. Set to start automatically.")
    assert detail["ai_enabled"] is False
    # The old body-less resolve still works.
    assert api.put(f"/api/v1/alerts/{p3.id}/resolve").status_code == 200


def test_bulk_and_groups(db, monkeypatch):
    p1, p3 = _seed_queue(db)
    api = _api(db, monkeypatch)
    groups = api.get("/api/v1/alerts/groups", params={"by": "client"}).json()
    assert groups[0]["label"] == "Vasgroup" and groups[0]["count"] == 2 and groups[0]["priority"] == 1
    issues = {g["key"]: g["title"] for g in api.get("/api/v1/alerts/groups").json()}
    assert issues == {"service_stopped": "Service stopped", "high_cpu": "High CPU"}
    result = api.post("/api/v1/alerts/bulk", json={"ids": [p1.id, p3.id, 999], "action": "take"}).json()
    assert result == {"done": [p1.id, p3.id], "failed": [999]}


def test_a_site_that_goes_offline_together_is_one_p1(db, monkeypatch):
    now = utcnow_naive()
    for i in range(3, 7):
        db.add(Device(id=i, hostname=f"PC-{i}", platform="windows", client_id=1, rustdesk_id=str(i), location_id=5,
                      status=DeviceStatus.OFFLINE, last_seen=now - timedelta(minutes=30)))
    db.commit()
    for i in range(3, 6):
        AlertEngine(db)._open_alert(i, AlertKind.DEVICE_OFFLINE, AlertSeverity.WARNING, f"PC-{i} offline", device=db.get(Device, i))
    items = _api(db, monkeypatch).get("/api/v1/alerts/queue").json()["items"]
    assert items[0]["kind"] == "site_outage" and items[0]["priority"] == 1
    assert items[0]["title"] == "Site offline · Durrës office" and len(items[0]["member_ids"]) == 3


def test_an_unowned_p1_is_sent_again_after_30_minutes_of_working_hours(db, monkeypatch):
    p1, _ = _seed_queue(db)
    p1.last_seen_at = p1.created_at = utcnow_naive() - timedelta(minutes=45)
    db.commit()
    sent = []
    monkeypatch.setattr("app.services.notification_service.NotificationService.dispatch", lambda self, **kw: sent.append(kw))
    monday_10 = datetime(2026, 10, 19, 8, 0, tzinfo=timezone.utc)  # 10:00 in Tirana
    monkeypatch.setattr("app.services.alert_center_service.utcnow", lambda: monday_10)
    p1.last_seen_at = p1.created_at = monday_10.replace(tzinfo=None) - timedelta(minutes=45)
    db.commit()
    assert AlertCenterService(db).escalate_unowned(monday_10) == 1
    assert sent and sent[0]["payload"]["reminder"] is True
    assert AlertCenterService(db).escalate_unowned(monday_10) == 0  # once
    sunday = datetime(2026, 10, 18, 8, 0, tzinfo=timezone.utc)
    p1.escalated_at = None
    db.commit()
    assert AlertCenterService(db).escalate_unowned(sunday) == 0


def test_findings_list_security_and_pending_restarts(db, monkeypatch):
    weak = {"defender": {"present": True, "antivirus_enabled": False}, "firewall": {"domain": True, "private": False, "public": True}}
    since = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
    health = parse_device_health({"reboot_pending": True, "reboot_reasons": ["windows_update"]})
    health = health.model_copy(update={"reboot_pending_since": datetime.fromisoformat(since)})
    db.add(DeviceInventory(device_id=2, security_json=json.dumps(weak), health_json=health.model_dump_json(),
                           collected_at=utcnow_naive()))
    db.commit()
    page = _api(db, monkeypatch).get("/api/v1/alerts/findings").json()
    kinds = {(i["type"], i["severity"]) for i in page["items"]}
    assert ("security", "high") in kinds and ("reboot", "medium") in kinds
    assert page["counts"] == {"security": 1, "reboot": 1}


def test_the_quality_report_finds_the_noisy_rules(db, monkeypatch):
    engine = AlertEngine(db)
    pc = db.get(Device, 1)
    for _ in range(3):
        alert = engine._open_alert(1, AlertKind.HIGH_RAM, AlertSeverity.WARNING, "RAM high", device=pc)
        engine.resolve_alert(alert, reason="ok", cooldown_seconds=0)
    other = engine._open_alert(1, AlertKind.HIGH_CPU, AlertSeverity.WARNING, "CPU high", device=pc)
    AlertCenterService(db).resolve(other.id, None, db.get(Operator, 1), resolution="false_positive")
    report = _api(db, monkeypatch).get("/api/v1/alerts/quality").json()
    rows = {r["issue"]: r for r in report["rows"]}
    assert rows["high_ram"]["opened"] == 1 and rows["high_ram"]["reopened"] == 2 and rows["high_ram"]["flapping"] == 1
    assert rows["high_ram"]["noise_pct"] == 100.0
    assert rows["high_cpu"]["false_positive"] == 1 and rows["high_cpu"]["noise_pct"] == 100.0


# ── words and runbooks ──────────────────────────────────────────────────────

def test_the_value_is_the_measurement_not_the_threshold():
    text = describe_alert("high_cpu", "", "CPU above 95% for 15 min on ARCH-03 (now 98%)", None, "warning")
    assert text.value == "98%" and text.summary == "CPU above 95% for 15 min"
    text = describe_alert("critical_events", "evt:shutdown", "Unexpected shutdown: 2 times in 7 days on X",
                          "… · last 19 Oct 18:59 UTC · monitor critical_events", "warning")
    assert text.title == "Unexpected shutdown" and text.summary == "2× in 7 days · last 19 Oct 18:59 UTC"


def test_every_alert_kind_has_a_runbook_and_commands_have_a_known_risk():
    for kind in AlertKind:
        if kind in (AlertKind.HIGH_NETWORK, AlertKind.HEARTBEAT_STALE, AlertKind.CRITICAL_EVENTS):
            continue
        assert runbook_for(kind) is not None, kind
    for key in ("evt:shutdown", "evt:bsod", "evt:hardware", "evt:disk_bad", "evt:disk_retry", "evt:filesystem"):
        assert runbook_for("critical_events", key).key == key
    for runbook in RUNBOOKS.values():
        for command in runbook.commands:
            assert command.risk in ("read_only", "changes_settings", "needs_restart", "data_risk")
            assert "{" not in command.script or "@{" in command.script or "{ " in command.script


# ── AI analysis ─────────────────────────────────────────────────────────────

def test_destructive_commands_are_marked_whatever_the_model_says():
    assert checked_risk("Get-Volume", "read_only") == "read_only"
    assert checked_risk("Format-Volume -DriveLetter D", "read_only") == "data_risk"
    assert checked_risk("Remove-Item C:\\Temp -Recurse -Force", "changes_settings") == "data_risk"
    assert checked_risk("Restart-Computer -Force", "read_only") == "needs_restart"
    assert checked_risk("Set-NetFirewallProfile -Enabled True", "read_only") == "changes_settings"
    assert checked_risk("", "data_risk") == "none"


def test_names_and_addresses_never_leave_the_server(db):
    redactor = Redactor()
    label = redactor.add_device(db.get(Device, 1))
    text = redactor.text("RECEPTION-08 of Vasgroup, user ana.k from 91.92.1.2 mailed ana@vas.al")
    assert label == "DEVICE-1"
    assert text == "DEVICE-1 of CLIENT, user USER from IP mailed EMAIL"


class _FakeMessages:
    def __init__(self, calls, answer):
        self.calls = calls
        self.answer = answer

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            stop_reason="end_turn",
            model=kwargs["model"],
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=json.dumps(self.answer))],
            usage=SimpleNamespace(input_tokens=5000, output_tokens=2500, cache_creation_input_tokens=0, cache_read_input_tokens=0),
        )


ANSWER = {
    "summary": "Tri rinisje pa fikje normale.",
    "likely_causes": [{"cause": "Ndërprerje korrenti", "confidence": "high", "evidence": "Asnjë 1001"}],
    "diagnostic_steps": [{"step": "Lexo eventet 41", "command": "Get-WinEvent -LogName System -MaxEvents 5", "risk": "read_only"}],
    "fix_steps": [{"step": "Pastro", "command": "Remove-Item C:\\Temp -Recurse", "risk": "read_only"}],
    "verify": "Asnjë 41 i ri.", "escalate_when": "Disa PC njëherësh.", "missing_information": [],
}


def test_an_analysis_is_redacted_structured_reused_and_limited(db, monkeypatch):
    calls = []
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(settings, "AI_DAILY_LIMIT", 2)
    monkeypatch.setattr(AlertAIService, "_client", lambda self: SimpleNamespace(
        beta=SimpleNamespace(messages=_FakeMessages(calls, ANSWER))))
    monkeypatch.setattr(alert_ai_service, "audit_log", lambda *a, **k: None, raising=False)
    _store_health(db, 1, [_event(1, "BugCheck", 1001, 2, "RECEPTION-08 stopped with a blue screen")])
    MonitorAlertService(db).evaluate_reports(db.get(Device, 1))
    [alert] = _open(db, AlertKind.CRITICAL_EVENTS)
    api = _api(db, monkeypatch)

    first = api.post(f"/api/v1/alerts/{alert.id}/analysis", json={}).json()
    assert first["result"]["summary"] == "Tri rinisje pa fikje normale." and first["cached"] is False
    assert first["result"]["fix_steps"][0]["risk"] == "data_risk"
    assert first["cost_usd"] == pytest.approx(0.07)
    request = calls[0]
    sent = request["messages"][0]["content"]
    assert "RECEPTION-08" not in sent and "Vasgroup" not in sent and "ana.k" not in sent
    assert "DEVICE-1" in sent and "shqip" in sent
    assert request["model"] == "claude-opus-5-5" and request["fallbacks"] == "default"
    assert request["betas"] == ["server-side-fallback-2026-07-01"]
    assert request["output_config"]["format"]["type"] == "json_schema"
    assert request["thinking"] == {"type": "adaptive"}

    again = api.post(f"/api/v1/alerts/{alert.id}/analysis", json={}).json()
    assert again["cached"] is True and len(calls) == 1
    assert api.post(f"/api/v1/alerts/{alert.id}/analysis", json={"force": True}).status_code == 200
    limited = api.post(f"/api/v1/alerts/{alert.id}/analysis", json={"force": True})
    assert limited.status_code == 429
    assert db.query(AlertAnalysis).count() == 2
    rated = api.post(f"/api/v1/alerts/analysis/{first['id']}/rating", json={"rating": 1}).json()
    assert rated["rating"] == 1
    assert api.get(f"/api/v1/alerts/{alert.id}").json()["analysis"]["id"] == first["id"] + 1


def test_without_a_key_the_analysis_is_off(db, monkeypatch):
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
    p1, _ = _seed_queue(db)
    response = _api(db, monkeypatch).post(f"/api/v1/alerts/{p1.id}/analysis", json={})
    assert response.status_code == 503
