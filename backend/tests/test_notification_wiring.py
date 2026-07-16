"""Notification Engine wiring regression: proves each required event source
(Alert Engine, Remote Actions, Terminal, Enrollment, Maintenance) actually
calls NotificationService.dispatch() at the right point with the right
event_type — without re-implementing each service's full business logic.

Patches NotificationService.dispatch at the class level: every call site
does `NotificationService(db).dispatch(...)`, which resolves through the
same class object regardless of which module imports it, so one monkeypatch
intercepts every wired call site.
"""

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_activity_event import DeviceActivityEvent
from app.models.remote_action import ActionStatus
from app.schemas.agent import AgentEnrollmentRequest
from app.schemas.remote_action import ActionType, RemoteActionCreate
from app.services.alert_engine import AlertEngine
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.device_maintenance_service import DeviceMaintenanceService
from app.services.notification_service import NotificationService
from app.services.remote_action_service import RemoteActionService
from app.core.time import utcnow
from datetime import timedelta


@pytest.fixture
def spy(monkeypatch):
    calls = []

    def _dispatch(self, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(NotificationService, "dispatch", _dispatch)
    return calls


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def _device(db, **overrides):
    defaults = dict(hostname="host-1", device_type=DeviceType.SERVER, status=DeviceStatus.ONLINE)
    defaults.update(overrides)
    device = Device(**defaults)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


# ---- Alert Engine ---------------------------------------------------------

def test_alert_engine_device_offline_fires_both_events(spy):
    db = _db()
    device = _device(db)
    AlertEngine(db).evaluate_device_offline(device)
    event_types = {c["event_type"] for c in spy}
    assert "device_offline" in event_types
    assert "critical_alert" in event_types


def test_alert_engine_resolve_device_offline_fires_device_online(spy):
    db = _db()
    device = _device(db)
    AlertEngine(db).evaluate_device_offline(device)
    spy.clear()
    AlertEngine(db).resolve_device_offline(device)
    assert any(c["event_type"] == "device_online" for c in spy)


def test_alert_engine_warning_alert_does_not_fire_critical_alert(spy):
    db = _db()
    device = _device(db)
    AlertEngine(db).evaluate_telemetry(device, cpu_percent=80.0, ram_percent=None, disk_percent=None)
    assert all(c["event_type"] != "critical_alert" for c in spy)


# ---- Remote Actions ---------------------------------------------------------

def _queue(db, device, action_type=ActionType.PING):
    svc = RemoteActionService(db)
    return svc.queue_action(device.id, RemoteActionCreate(action_type=action_type, created_by="tester"))


def test_remote_action_complete_fires_remote_action_completed(spy):
    db = _db()
    device = _device(db)
    action = _queue(db, device)
    RemoteActionService(db).complete(action.id, result_message="ok")
    assert any(c["event_type"] == "remote_action_completed" for c in spy)


def test_remote_action_fail_fires_remote_action_failed(spy):
    db = _db()
    device = _device(db)
    action = _queue(db, device)
    RemoteActionService(db).fail(action.id, error_message="boom")
    assert any(c["event_type"] == "remote_action_failed" for c in spy)


def test_remote_action_fail_preserves_complete_error_in_action_and_audit(spy):
    db = _db()
    device = _device(db)
    action = _queue(db, device, ActionType.REINSTALL_RUSTDESK)
    root_cause = "native Remote Support repair failed: failed to replace app.so: " + "Access is denied; " * 20

    failed = RemoteActionService(db).fail(action.id, error_message=root_cause)

    assert failed.error_message == root_cause
    audit = (
        db.query(DeviceActivityEvent)
        .filter_by(device_id=device.id, event_type="remote_action")
        .order_by(DeviceActivityEvent.id.desc())
        .first()
    )
    assert audit is not None
    assert len(audit.summary) <= 255
    assert root_cause in audit.detail


def test_remote_support_ui_failure_preserves_diagnostics_in_action_and_audit(spy):
    db = _db()
    device = _device(db)
    action = _queue(db, device, ActionType.REINSTALL_RUSTDESK)
    summary = "native Remote Support repair failed: ui_launch_failed (see start_ui diagnostics)"
    diagnostics = (
        "ui_launch_failed: start_ui diagnostics: agent_session_id=0; "
        "active_interactive_session_id=7; created_process_pid=41; "
        'visible_windows=[handle=0x101 width=16 height=16 result="width 16 < 200"]'
    )

    failed = RemoteActionService(db).fail(
        action.id,
        error_message=summary,
        stderr_output=diagnostics,
    )

    assert failed.error_message == summary
    assert failed.stderr_output == diagnostics
    audit = (
        db.query(DeviceActivityEvent)
        .filter_by(device_id=device.id, event_type="remote_action")
        .order_by(DeviceActivityEvent.id.desc())
        .first()
    )
    assert audit is not None
    assert diagnostics in audit.detail


def test_self_update_complete_fires_agent_update_completed(spy):
    db = _db()
    # Device hasn't reported the new version yet, so `complete()` takes the
    # "awaiting heartbeat verification" path (RUNNING, no event) — matching
    # the real self-update flow.
    device = _device(db, agent_version="2.1.5", agent_sha256="old-sha")
    action = RemoteActionService(db).queue_action(
        device.id,
        RemoteActionCreate(
            action_type=ActionType.SELF_UPDATE,
            parameters={"version": "2.1.6", "sha256": "abc123"},
            created_by="tester",
        ),
    )
    RemoteActionService(db).complete(action.id)
    assert spy == []  # not verified yet — no event fired

    # Simulate the next heartbeat reporting the new version.
    device.agent_version = "2.1.6"
    device.agent_sha256 = "abc123"
    db.commit()
    RemoteActionService(db).verify_self_update_for_device(device.id)
    assert any(c["event_type"] == "agent_update_completed" for c in spy)


def test_self_update_fail_fires_agent_update_failed(spy):
    db = _db()
    device = _device(db)
    action = RemoteActionService(db).queue_action(
        device.id, RemoteActionCreate(action_type=ActionType.SELF_UPDATE, created_by="tester"),
    )
    RemoteActionService(db).fail(action.id, error_message="download failed")
    assert any(c["event_type"] == "agent_update_failed" for c in spy)


# ---- Terminal ---------------------------------------------------------

def test_terminal_session_started_and_ended(spy):
    from app.websocket.terminal_routes import _notify_session_started, _notify_session_ended

    db = _db()
    device = _device(db)
    session = SimpleNamespace(id="sess-1", device_id=device.id, operator_username="mario", duration_seconds=42)

    _notify_session_started(db, session)
    assert any(c["event_type"] == "terminal_session_started" for c in spy)

    spy.clear()
    _notify_session_ended(db, session, "operator_closed")
    assert any(c["event_type"] == "terminal_session_ended" for c in spy)


# ---- Enrollment ---------------------------------------------------------

def test_enrollment_failure_fires_enrollment_failed(spy):
    db = _db()
    svc = AgentEnrollmentService(db)
    svc._record_audit(
        payload=AgentEnrollmentRequest(hostname="new-host"),
        result="failed",
        reason="token_expired",
    )
    assert any(c["event_type"] == "enrollment_failed" for c in spy)


def test_enrollment_success_does_not_fire(spy):
    db = _db()
    svc = AgentEnrollmentService(db)
    svc._record_audit(
        payload=AgentEnrollmentRequest(hostname="new-host"),
        result="success",
    )
    assert spy == []


# ---- Maintenance ---------------------------------------------------------

def test_clear_maintenance_fires_maintenance_finished(spy):
    db = _db()
    device = _device(db, is_in_maintenance=True)
    DeviceMaintenanceService(db).clear_maintenance(device)
    assert any(c["event_type"] == "maintenance_finished" for c in spy)


def test_expire_if_needed_fires_maintenance_finished(spy):
    db = _db()
    device = _device(db, is_in_maintenance=True)
    # Set in-memory only (not re-fetched from SQLite) to avoid a pre-existing,
    # unrelated tz-aware/naive comparison quirk when SQLite round-trips a
    # tz-aware datetime — out of scope for this wiring test.
    device.maintenance_ends_at = utcnow() - timedelta(minutes=1)
    DeviceMaintenanceService(db).expire_if_needed(device)
    assert any(c["event_type"] == "maintenance_finished" for c in spy)


def test_expire_if_needed_no_op_does_not_fire(spy):
    db = _db()
    device = _device(db, is_in_maintenance=False)
    DeviceMaintenanceService(db).expire_if_needed(device)
    assert spy == []
