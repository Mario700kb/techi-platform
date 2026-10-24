"""Automation: scheduled agent updates in waves. The schedule is in the
operators' timezone; a run takes only online devices of its scope that need
the update, goes wave by wave, halts when a wave fails beyond the limit, and
ends when nothing is left or its window closes."""
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import automation as endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.automation import AutomationRun, AutomationTask
from app.models.device import Device, DeviceStatus
from app.models.operator import OperatorRole
from app.models.remote_action import ActionStatus, RemoteAction
from app.services import agent_command_service as command_module
from app.services import automation_service as automation

SHA = "a" * 64
NOW = datetime(2026, 10, 25, 1, 0)  # naive UTC: 03:00 in Tirana (CEST ends 25 Oct 03:00)


class FakePackages:
    def latest_active(self, platform, *, file_type=None):
        if platform == "windows-amd64" and file_type == "agent_binary":
            return SimpleNamespace(version="2.1.44", sha256=SHA)
        if platform == "windows-amd64" and file_type == "agent_update_msi":
            return SimpleNamespace(version="2.1.44.0", sha256="c" * 64)
        return None

    def agent_binary_download_url(self):
        return "/api/v1/agent-packages/agent-binary/download"

    def agent_update_msi_download_url(self):
        return "/api/v1/agent-packages/agent-update-msi/download"


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    monkeypatch.setattr(command_module, "AgentPackageService", FakePackages)
    monkeypatch.setattr(endpoint, "AgentPackageService", FakePackages)
    monkeypatch.setattr("app.services.action_push.push_action_if_connected", lambda *a, **k: False)
    devices = [
        Device(id=i, hostname=f"PC-{i}", agent_id=f"a{i}", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.35", client_id=1 if i <= 6 else 2)
        for i in range(1, 9)
    ]
    devices += [
        Device(id=20, hostname="Current", agent_id="a20", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.44", agent_sha256=SHA, client_id=1),
        Device(id=21, hostname="Offline", agent_id="a21", platform="windows", status=DeviceStatus.OFFLINE,
               agent_version="2.1.35", client_id=1),
        Device(id=22, hostname="Maint", agent_id="a22", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.35", client_id=1, is_in_maintenance=True),
        Device(id=23, hostname="Archived", agent_id="a23", platform="windows", status=DeviceStatus.ONLINE,
               agent_version="2.1.35", client_id=1, is_archived=True),
    ]
    session.add_all(devices)
    session.commit()
    return session


def task(**over) -> AutomationTask:
    values = dict(name="Agent update", kind="agent_update", enabled=True, scope="default", skip_maintenance=True,
                  schedule="once", run_at=NOW, window_minutes=240, wave_sizes=[2, 0], wave_wait_minutes=0,
                  max_failure_percent=20, created_by="denis", next_run_at=NOW)
    values.update(over)
    return AutomationTask(**values)


def finish_wave(db, run, status=ActionStatus.COMPLETED, keep_running=0):
    actions = db.query(RemoteAction).filter(RemoteAction.batch_id == run.waves[-1]["batch_id"]).all()
    for a in actions[keep_running:]:
        a.status = status
    db.commit()


# ── schedule ────────────────────────────────────────────────────────────────

def test_the_schedule_is_in_tirana_time(monkeypatch):
    monkeypatch.setattr(settings, "DISPLAY_TIMEZONE", "Europe/Tirane")
    daily = task(schedule="daily", time_of_day="02:00", run_at=None)
    # 24 Oct 22:00 UTC = 25 Oct 00:00 Tirana (CEST): next 02:00 Tirana = 00:00 UTC.
    assert automation.next_run_after(daily, datetime(2026, 10, 24, 22, 0)) == datetime(2026, 10, 25, 0, 0)
    # After the clocks go back (CET): 26 Oct 02:00 Tirana = 01:00 UTC.
    assert automation.next_run_after(daily, datetime(2026, 10, 25, 2, 0)) == datetime(2026, 10, 26, 1, 0)
    weekly = task(schedule="weekly", time_of_day="03:30", weekday=6, run_at=None)  # Sunday
    assert automation.next_run_after(weekly, datetime(2026, 10, 26, 12, 0)) == datetime(2026, 11, 1, 2, 30)
    monthly = task(schedule="monthly", time_of_day="04:00", day_of_month=1, run_at=None)
    assert automation.next_run_after(monthly, datetime(2026, 10, 26, 12, 0)) == datetime(2026, 11, 1, 3, 0)
    once = task(schedule="once", run_at=datetime(2026, 10, 30, 0, 0))
    assert automation.next_run_after(once, datetime(2026, 10, 26)) == datetime(2026, 10, 30, 0, 0)
    assert automation.next_run_after(once, datetime(2026, 10, 31)) is None


# ── runs ────────────────────────────────────────────────────────────────────

def test_a_run_goes_wave_by_wave_and_ends_when_nothing_is_left(db):
    t = task()
    db.add(t)
    db.commit()

    assert automation.sweep(db, NOW) == {"started": 1, "running": 1}
    run = db.query(AutomationRun).one()
    assert t.next_run_at is None  # a one-off does not come back
    assert len(run.waves) == 1 and len(run.waves[0]["device_ids"]) == 2
    # Only online, non-archived, not-in-maintenance devices that need it.
    chosen = set(run.waves[0]["device_ids"])
    assert chosen <= set(range(1, 9))

    automation.sweep(db, NOW + timedelta(minutes=1))  # wave 1 still running: nothing new
    assert len(run.waves) == 1
    finish_wave(db, run)
    automation.sweep(db, NOW + timedelta(minutes=2))  # settles, wait 0 → wave 2 with everything left
    assert run.waves[0]["completed"] == 2 and run.waves[0]["settled_at"]
    automation.sweep(db, NOW + timedelta(minutes=3))
    assert len(run.waves) == 2 and len(run.waves[1]["device_ids"]) == 6
    assert not chosen & set(run.waves[1]["device_ids"])
    finish_wave(db, run)
    automation.sweep(db, NOW + timedelta(minutes=4))
    automation.sweep(db, NOW + timedelta(minutes=5))
    assert run.status == "completed" and run.finished_at is not None
    updated = {i for w in run.waves for i in w["device_ids"]}
    assert updated == set(range(1, 9))  # never 20 (current), 21 (offline), 22 (maintenance), 23 (archived)


def test_a_wave_that_fails_beyond_the_limit_halts_the_run(db):
    db.add(task(wave_sizes=[4, 0], max_failure_percent=25))
    db.commit()
    automation.sweep(db, NOW)
    run = db.query(AutomationRun).one()
    actions = db.query(RemoteAction).filter(RemoteAction.batch_id == run.waves[0]["batch_id"]).all()
    actions[0].status = ActionStatus.FAILED
    actions[1].status = ActionStatus.EXPIRED
    for a in actions[2:]:
        a.status = ActionStatus.COMPLETED
    db.commit()
    automation.sweep(db, NOW + timedelta(minutes=1))
    assert run.status == "halted" and "2 of 4" in run.reason
    automation.sweep(db, NOW + timedelta(minutes=5))
    assert len(run.waves) == 1  # nothing more went out


def test_an_unfinished_wave_settles_after_the_limit_and_counts_as_failed(db):
    db.add(task(wave_sizes=[2, 0], max_failure_percent=0))
    db.commit()
    automation.sweep(db, NOW)
    run = db.query(AutomationRun).one()
    automation.sweep(db, NOW + timedelta(minutes=automation.WAVE_SETTLE_MINUTES + 1))
    assert run.waves[0]["unfinished"] == 2 and run.status == "halted"


def test_the_window_closes_before_the_next_wave(db):
    db.add(task(window_minutes=15, wave_wait_minutes=20))
    db.commit()
    automation.sweep(db, NOW)
    run = db.query(AutomationRun).one()
    finish_wave(db, run)
    automation.sweep(db, NOW + timedelta(minutes=1))
    automation.sweep(db, NOW + timedelta(minutes=22))
    assert run.status == "window_closed" and len(run.waves) == 1


def test_scope_and_exclusions(db):
    db.add(task(scope="client", scope_value="1", excluded_device_ids=[1, 2], wave_sizes=[0]))
    db.commit()
    automation.sweep(db, NOW)
    run = db.query(AutomationRun).one()
    assert set(run.waves[0]["device_ids"]) == {3, 4, 5, 6}

    t2 = task(name="Not client 2", excluded_client_ids=[1], wave_sizes=[0])
    db.add(t2)
    db.commit()
    keep, _ = automation.eligible_devices(db, t2)
    assert {d.id for d in keep} == {7, 8}


def test_a_due_start_is_skipped_while_the_previous_run_is_in_progress(db):
    t = task(schedule="daily", time_of_day="03:00", run_at=None)
    db.add(t)
    db.commit()
    automation.sweep(db, NOW)
    t.next_run_at = NOW + timedelta(minutes=1)
    db.commit()
    automation.sweep(db, NOW + timedelta(minutes=2))
    assert db.query(AutomationRun).count() == 1
    # The next start moved on (25 Oct, clocks back: 03:00 Tirana is 02:00 UTC).
    assert t.next_run_at == datetime(2026, 10, 25, 2, 0)


# ── API ─────────────────────────────────────────────────────────────────────

def _client(db, role=OperatorRole.ADMIN.value):
    api = FastAPI()
    api.include_router(endpoint.router)
    operator = SimpleNamespace(id=1, username="denis", role=role)
    api.dependency_overrides[get_db] = lambda: db
    api.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(api)


BODY = {"name": "Weekly agent update", "schedule": "weekly", "time_of_day": "02:00", "weekday": 6,
        "excluded_client_ids": [2], "wave_sizes": [10, 50, 0], "wave_wait_minutes": 30, "max_failure_percent": 5}


def test_administrators_create_preview_run_and_stop_a_task(db):
    client = _client(db)
    r = client.post("/automation/tasks", json=BODY)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["next_run_at"] and created["excluded_client_ids"] == [2]

    preview = client.get(f"/automation/tasks/{created['id']}/preview").json()
    assert preview == {"needs_update": 6, "up_to_date_or_busy": 1, "first_wave": 6, "version": "2.1.44"}

    run = client.post(f"/automation/tasks/{created['id']}/run")
    assert run.status_code == 201 and len(run.json()["waves"]) == 1
    assert client.post(f"/automation/tasks/{created['id']}/run").status_code == 409
    assert client.delete(f"/automation/tasks/{created['id']}").status_code == 409

    stopped = client.post(f"/automation/runs/{run.json()['id']}/cancel")
    assert stopped.status_code == 200 and stopped.json()["status"] == "cancelled"
    assert client.delete(f"/automation/tasks/{created['id']}").status_code == 204


def test_bad_tasks_are_refused_and_operators_cannot_manage_them(db):
    client = _client(db)
    for bad in (
        {**BODY, "wave_sizes": [10, 0, 50]},
        {**BODY, "time_of_day": "25:00"},
        {**BODY, "schedule": "once"},
        {**BODY, "scope": "client"},
        {**BODY, "scope": "devices"},
    ):
        assert client.post("/automation/tasks", json=bad).status_code == 422, bad
    assert _client(db, OperatorRole.OPERATOR.value).get("/automation/tasks").status_code == 403
