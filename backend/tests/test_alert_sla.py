"""Alert deadlines and escalation (alert_sla), waiting on someone else,
recurring problems, incidents across a client's devices, the duty roster,
the handover list and the deadline report. Working hours are the defaults:
Monday–Friday 08:00–17:00, Europe/Tirane (UTC+2 until 25 Oct 2026, then +1)."""
from datetime import date, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import alerts as alerts_endpoint
from app.core.auth import get_current_operator, get_operator_scope
from app.db.base import Base
from app.db.session import get_db
from app.models.alert import AlertActivity, AlertDutyShift, AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import Operator
from app.services.alert_engine import AlertEngine
from app.services.alert_sla import AlertSlaService, WorkClock, deadline_fields, restamp

# Naive UTC, as the columns store it.
MON_10 = datetime(2026, 10, 19, 8, 0)  # Monday 10:00 in Tirana
FRI_1650 = datetime(2026, 10, 23, 14, 50)  # Friday 16:50 in Tirana


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Client(id=1, name="Vasgroup", slug="vasgroup"))
    session.add_all([
        Device(id=1, hostname="RECEPTION-08", platform="windows", client_id=1, rustdesk_id="1",
               device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE),
        Device(id=2, hostname="SRV-FILE-02", platform="windows", client_id=1, rustdesk_id="2",
               device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE),
        Device(id=3, hostname="PC-03", platform="windows", client_id=1, rustdesk_id="3", device_type=DeviceType.CLIENT),
        Device(id=4, hostname="PC-04", platform="windows", client_id=1, rustdesk_id="4", device_type=DeviceType.CLIENT),
    ])
    session.add_all([
        Operator(id=1, username="denis", email="d@x.al", hashed_password="x", role="admin"),
        Operator(id=2, username="mario", email="m@x.al", hashed_password="x", role="operator"),
        Operator(id=3, username="ana", email="a@x.al", hashed_password="x", role="operator"),
    ])
    session.commit()
    yield session
    session.close()


@pytest.fixture()
def sent(monkeypatch):
    calls = []
    monkeypatch.setattr("app.services.notification_service.NotificationService.dispatch",
                        lambda self, **kw: calls.append(kw))
    return calls


def _escalations(sent):
    return [c for c in sent if c["event_type"] == "alert_escalated"]


def _api(db, monkeypatch, operator_id=1):
    monkeypatch.setattr(alerts_endpoint, "build_token_usage_alerts", lambda _db: [])
    app = FastAPI()
    app.include_router(alerts_endpoint.router, prefix="/api/v1/alerts")
    operator = db.get(Operator, operator_id)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.dependency_overrides[get_operator_scope] = lambda: None
    return TestClient(app)


def _open(db, device_id, kind=AlertKind.SERVICE_STOPPED, severity=AlertSeverity.CRITICAL, fingerprint="svc:veeam",
          at=MON_10):
    alert = AlertEngine(db)._open_alert(device_id, kind, severity, f"{kind.value} on {device_id}",
                                        device=db.get(Device, device_id), fingerprint=fingerprint)
    restamp(alert, device_id == 2, at)  # SRV-FILE-02 is the server
    db.commit()
    return alert


def _duty(db, operator_id=2, backup=3, on=date(2026, 10, 19)):
    db.add(AlertDutyShift(starts_on=on, ends_on=on + timedelta(days=6), operator_id=operator_id,
                          backup_operator_id=backup, created_by="denis"))
    db.commit()


# ── the clock ───────────────────────────────────────────────────────────────

def test_the_clock_counts_working_hours_across_a_weekend_and_the_clock_change():
    clock = WorkClock()
    # Friday 16:50 + 60 working minutes: 10 on Friday, 50 on Monday 26 Oct,
    # when Tirana is back on UTC+1 (08:50 local = 07:50 UTC).
    assert clock.add(FRI_1650, 60) == datetime(2026, 10, 26, 7, 50)
    assert clock.between(FRI_1650, datetime(2026, 10, 26, 7, 50)) == pytest.approx(60)
    # Every hour counts for a P1 on a server.
    assert clock.add(FRI_1650, 60, round_the_clock=True) == FRI_1650 + timedelta(hours=1)
    # Before opening time the clock starts at 08:00.
    assert clock.add(datetime(2026, 10, 19, 4, 0), 15) == datetime(2026, 10, 19, 6, 15)


def test_deadlines_follow_priority_and_a_server_p1_counts_every_hour():
    server_p1 = deadline_fields(1, True, FRI_1650)
    assert server_p1["sla_24x7"] is True
    assert server_p1["ack_due_at"] == FRI_1650 + timedelta(minutes=15)
    assert server_p1["resolve_due_at"] == FRI_1650 + timedelta(hours=4)
    assert server_p1["next_check_at"] == FRI_1650 + timedelta(minutes=7.5)  # step 1 at half the time to take
    pc_p2 = deadline_fields(2, False, FRI_1650)
    assert pc_p2["sla_24x7"] is False
    assert pc_p2["ack_due_at"] == datetime(2026, 10, 26, 7, 50)
    p4 = deadline_fields(4, False, MON_10)
    assert p4["ack_due_at"] is None and p4["next_check_at"] == p4["resolve_due_at"]


def test_an_opened_alert_carries_its_deadlines(db):
    alert = AlertEngine(db)._open_alert(2, AlertKind.SERVICE_STOPPED, AlertSeverity.CRITICAL, "Veeam stopped",
                                        device=db.get(Device, 2), fingerprint="svc:veeam")
    assert alert.priority == 1 and alert.sla_24x7 is True
    assert alert.ack_due_at == alert.sla_started_at + timedelta(minutes=15)
    assert alert.next_check_at is not None and alert.sla_step == 0


# ── escalation ──────────────────────────────────────────────────────────────

def test_an_unowned_p1_goes_to_the_dispatcher_then_up_the_steps(db, sent):
    _duty(db)
    alert = _open(db, 2)
    service = AlertSlaService(db)
    assert service.sweep(MON_10 + timedelta(minutes=5))["fired"] == 0
    service.sweep(MON_10 + timedelta(minutes=8))
    db.refresh(alert)
    assert alert.assigned_to_id == 2 and alert.acknowledged_at is None and alert.sla_step == 1
    assert sent[-1]["event_type"] == "alert_escalated" and sent[-1]["payload"]["step"] == 1
    assert sent[-1]["payload"]["to"] == ["mario"]
    # Assigned is not taken: at 15 minutes the dispatcher and the stand-in hear again.
    service.sweep(MON_10 + timedelta(minutes=16))
    db.refresh(alert)
    assert alert.sla_step == 2 and sent[-1]["payload"]["step"] == 2 and sent[-1]["payload"]["to"] == ["ana", "mario"]
    # Taken, with a note: half time passes quietly, the deadline does not.
    api_alert = db.get(DeviceAlert, alert.id)
    api_alert.acknowledged_at = MON_10 + timedelta(minutes=17)
    api_alert.first_action_at = MON_10 + timedelta(minutes=18)
    db.commit()
    before = len(sent)
    service.sweep(MON_10 + timedelta(hours=2, minutes=1))
    assert len(sent) == before
    service.sweep(MON_10 + timedelta(hours=4, minutes=1))
    db.refresh(alert)
    assert alert.sla_step == 4 and alert.next_check_at is None
    assert sent[-1]["payload"]["step"] == 4
    actions = [a.action for a in db.query(AlertActivity).filter(AlertActivity.alert_id == alert.id)]
    assert {"auto_assigned", "sla_take_missed", "sla_breached"} <= set(actions)
    assert "sla_no_progress" not in actions


def test_a_session_on_the_device_counts_as_progress(db, sent):
    from app.models.remote_support_connection import RemoteSupportConnection

    alert = _open(db, 2)
    alert.assigned_to_id = 1
    alert.acknowledged_at = MON_10 + timedelta(minutes=1)
    db.add(RemoteSupportConnection(device_id=2, conn_id=7, opened_at=MON_10 + timedelta(minutes=30)))
    db.commit()
    AlertSlaService(db).sweep(MON_10 + timedelta(hours=2, minutes=1))
    db.refresh(alert)
    assert alert.sla_step == 3 and alert.first_action_at == MON_10 + timedelta(minutes=30)
    assert not any(c["payload"]["step"] == 3 for c in _escalations(sent))


def test_a_p3_only_marks_its_deadlines_and_tells_nobody(db, sent):
    alert = _open(db, 1, kind=AlertKind.HIGH_CPU, severity=AlertSeverity.WARNING, fingerprint="")
    assert alert.priority == 3
    AlertSlaService(db).sweep(MON_10 + timedelta(days=5))
    db.refresh(alert)
    assert alert.sla_step == 4 and sent == []


def test_a_snoozed_alert_waits_for_its_snooze_to_end(db, sent):
    alert = _open(db, 2)
    alert.snoozed_until = MON_10 + timedelta(hours=1)
    db.commit()
    AlertSlaService(db).sweep(MON_10 + timedelta(minutes=20))
    db.refresh(alert)
    assert alert.sla_step == 0 and alert.next_check_at == MON_10 + timedelta(hours=1) and _escalations(sent) == []


def test_alerts_open_before_the_deploy_start_their_clock_at_the_first_sweep(db, sent):
    alert = _open(db, 2)
    for column in ("sla_started_at", "ack_due_at", "resolve_due_at", "next_check_at"):
        setattr(alert, column, None)
    db.commit()
    result = AlertSlaService(db).sweep(MON_10)
    db.refresh(alert)
    assert result["stamped"] == 1 and alert.sla_started_at == MON_10 and _escalations(sent) == []


# ── waiting, overdue, recurring ─────────────────────────────────────────────

def test_waiting_on_the_client_stops_the_clock(db, monkeypatch):
    alert = _open(db, 1, kind=AlertKind.LOW_DISK, severity=AlertSeverity.CRITICAL, fingerprint="vol:C:")
    assert alert.priority == 2
    due = alert.resolve_due_at
    monkeypatch.setattr("app.services.alert_center_service.utcnow_naive", lambda: MON_10 + timedelta(hours=1))
    api = _api(db, monkeypatch, operator_id=2)
    waiting = api.post(f"/api/v1/alerts/{alert.id}/wait", json={"reason": "client", "note": "User is out today"}).json()
    assert waiting["waiting_reason"] == "client" and waiting["sla_state"] == "waiting"
    assert waiting["assigned_to_name"] == "mario"
    db.refresh(alert)
    assert alert.next_check_at is None
    monkeypatch.setattr("app.services.alert_center_service.utcnow_naive", lambda: MON_10 + timedelta(hours=3))
    api.post(f"/api/v1/alerts/{alert.id}/resume")
    db.refresh(alert)
    assert alert.sla_paused_minutes == 120 and alert.resolve_due_at == due + timedelta(hours=2)
    assert alert.waiting_since is None and alert.next_check_at is not None


def test_the_overdue_view_lists_alerts_past_a_deadline(db, monkeypatch):
    late = _open(db, 2, at=datetime(2026, 10, 1, 8, 0))
    _open(db, 1, kind=AlertKind.HIGH_CPU, severity=AlertSeverity.WARNING, fingerprint="", at=datetime(2099, 1, 1))
    api = _api(db, monkeypatch)
    page = api.get("/api/v1/alerts/queue", params={"view": "overdue"}).json()
    assert [a["id"] for a in page["items"]] == [late.id] and page["items"][0]["sla_state"] == "overdue"
    assert api.get("/api/v1/alerts/count").json()["views"]["overdue"] == 1


def test_a_problem_back_after_a_fix_is_recurring_and_needs_its_cause(db, monkeypatch):
    engine = AlertEngine(db)
    alert = _open(db, 1, kind=AlertKind.LOW_DISK, severity=AlertSeverity.WARNING, fingerprint="vol:C:")
    api = _api(db, monkeypatch)
    api.put(f"/api/v1/alerts/{alert.id}/resolve", json={"resolution": "fixed", "note": "Cleared temp"})
    db.get(DeviceAlert, alert.id).cooldown_until = None
    db.commit()
    again = engine._open_alert(1, AlertKind.LOW_DISK, AlertSeverity.WARNING, "Disk C: 91%", device=db.get(Device, 1),
                               fingerprint="vol:C:")
    assert again.id == alert.id and again.recurring is True
    assert db.query(AlertActivity).filter(AlertActivity.alert_id == alert.id, AlertActivity.action == "fix_failed").count() == 1
    refused = api.put(f"/api/v1/alerts/{alert.id}/resolve", json={"resolution": "fixed", "note": "done"})
    assert refused.status_code == 422
    ok = api.put(f"/api/v1/alerts/{alert.id}/resolve",
                 json={"resolution": "fixed", "note": "WinSxS cleanup scheduled weekly; 40 GB free now"})
    assert ok.status_code == 200


# ── incidents ───────────────────────────────────────────────────────────────

def test_the_same_problem_on_three_devices_of_a_client_is_one_incident(db, monkeypatch, sent):
    engine = AlertEngine(db)
    first = engine._open_alert(1, AlertKind.SERVICE_STOPPED, AlertSeverity.CRITICAL, "Spooler stopped",
                               device=db.get(Device, 1), fingerprint="svc:spooler")
    second = engine._open_alert(3, AlertKind.SERVICE_STOPPED, AlertSeverity.CRITICAL, "Spooler stopped",
                                device=db.get(Device, 3), fingerprint="svc:spooler")
    assert second.parent_id is None  # two devices are not an incident yet
    third = engine._open_alert(4, AlertKind.SERVICE_STOPPED, AlertSeverity.CRITICAL, "Spooler stopped",
                               device=db.get(Device, 4), fingerprint="svc:spooler")
    db.refresh(second)
    assert second.parent_id == first.id and third.parent_id == first.id and first.parent_id is None
    api = _api(db, monkeypatch)
    items = api.get("/api/v1/alerts/queue", params={"view": "open"}).json()["items"]
    assert [(a["id"], a["followers"]) for a in items] == [(first.id, 2)]
    detail = api.get(f"/api/v1/alerts/{first.id}").json()
    assert [f["device_name"] for f in detail["incident"]["followers"]] == ["PC-03", "PC-04"]
    api.post(f"/api/v1/alerts/{first.id}/take")
    db.refresh(third)
    assert third.assigned_to_id == 1
    api.put(f"/api/v1/alerts/{first.id}/resolve", json={"resolution": "fixed", "note": "Driver rolled back"})
    db.refresh(second)
    db.refresh(third)
    assert second.state == AlertState.RESOLVED.value and third.resolution == "fixed"


def test_followers_go_back_on_their_own_when_the_lead_clears_by_itself(db):
    engine = AlertEngine(db)
    alerts = [engine._open_alert(i, AlertKind.SERVICE_STOPPED, AlertSeverity.CRITICAL, "Spooler stopped",
                                 device=db.get(Device, i), fingerprint="svc:spooler") for i in (1, 3, 4)]
    engine.resolve_alert(alerts[0], reason="ok")
    for follower in alerts[1:]:
        db.refresh(follower)
        assert follower.state == AlertState.OPEN.value and follower.parent_id is None
        assert follower.next_check_at is not None


# ── duty roster, handover, report ───────────────────────────────────────────

def test_only_an_admin_sets_the_duty_roster(db, monkeypatch):
    today = date.today()
    shift = {"starts_on": today.isoformat(), "ends_on": (today + timedelta(days=6)).isoformat(),
             "operator_id": 2, "backup_operator_id": 3}

    admin = _api(db, monkeypatch)
    created = admin.post("/api/v1/alerts/duty", json=shift).json()
    assert created["operator_name"] == "mario" and created["backup_name"] == "ana"
    bad = admin.post("/api/v1/alerts/duty", json={**shift, "backup_operator_id": 2})
    assert bad.status_code == 422
    duty = admin.get("/api/v1/alerts/duty").json()
    assert [s["id"] for s in duty["shifts"]] == [created["id"]]
    assert duty["deadlines"][0] == {"priority": 1, "ack_minutes": 15, "resolve_minutes": 240, "round_the_clock_on_servers": True}
    assert admin.delete(f"/api/v1/alerts/duty/{created['id']}").status_code == 204


def test_the_handover_lists_owned_and_urgent_alerts_with_the_last_note(db, monkeypatch):
    p1 = _open(db, 2)
    _open(db, 1, kind=AlertKind.HIGH_CPU, severity=AlertSeverity.WARNING, fingerprint="")  # P3, nobody's
    api = _api(db, monkeypatch)
    api.post(f"/api/v1/alerts/{p1.id}/notes", json={"text": "Veeam restarted, watching the next job"})
    rows = api.get("/api/v1/alerts/handover").json()
    assert [r["id"] for r in rows] == [p1.id] and rows[0]["last_note"] == "Veeam restarted, watching the next job"
    db.refresh(p1)
    assert p1.first_action_at is not None


def test_the_handover_is_sent_once_before_the_day_ends(db, sent):
    _open(db, 2)
    service = AlertSlaService(db)
    AlertSlaService._handover_sent_on = None
    assert service.send_handover_if_due(datetime(2026, 10, 19, 13, 0)) == 0  # 15:00: too early
    assert service.send_handover_if_due(datetime(2026, 10, 19, 14, 50)) == 1  # 16:50
    assert sent[-1]["event_type"] == "alert_handover" and "SRV-FILE-02" in sent[-1]["message"]
    assert service.send_handover_if_due(datetime(2026, 10, 19, 14, 55)) == 0


def test_the_quality_report_says_whether_deadlines_are_kept(db, monkeypatch):
    alert = _open(db, 2, at=utcnow_minus(30))
    api = _api(db, monkeypatch)
    api.post(f"/api/v1/alerts/{alert.id}/take")
    api.put(f"/api/v1/alerts/{alert.id}/resolve", json={"resolution": "fixed", "note": "Service restarted"})
    report = api.get("/api/v1/alerts/quality").json()["deadlines"]
    [p1] = [r for r in report["by_priority"] if r["priority"] == 1]
    assert p1["alerts"] == 1 and p1["owned_pct"] == 100.0 and p1["met_pct"] == 100.0 and p1["ack_met_pct"] is not None
    assert report["by_person"][0]["name"] == "denis" and report["fixed"] == 1


def utcnow_minus(minutes):
    from app.core.time import utcnow_naive

    return utcnow_naive() - timedelta(minutes=minutes)
