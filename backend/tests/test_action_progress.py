"""Live self-update progress.

The agent (2.1.32+) reports stage + overall percent to
POST /actions/{id}/progress; the server adds restarting/confirming from the
command channel for any agent version, and completion (100) from the
heartbeat. Every change goes out as action_status_changed carrying progress
and stage, and none of them may be swallowed by the publisher's dedupe.
"""
import json
import time
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import actions as actions_endpoints
from app.core.agent_auth import compute_callback_token
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.remote_action import ActionStatus, RemoteAction
from app.schemas.remote_action import RemoteActionResponse
from app.services import remote_action_service as ras
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.remote_action_service import RemoteActionService
from app.websocket import agent_channel_routes
from app.websocket.agent_channel import agent_command_channel
from app.websocket.publisher import RealtimeEventPublisher

AGENT_ID = "agent_PROGRESS_0123456789"
TARGET_SHA = "b" * 64


@pytest.fixture()
def make(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    db.add(Device(id=924, agent_id=AGENT_ID, hostname="Mario-Lenovo", platform="windows",
                  device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE,
                  agent_version="2.1.31", last_seen=utcnow()))
    db.commit()
    db.close()
    monkeypatch.setattr(agent_channel_routes, "SessionLocal", factory)
    agent_command_channel.presence_paused = False
    yield factory
    agent_command_channel.presence_paused = False


@pytest.fixture()
def events(monkeypatch):
    published = []

    def publish_threadsafe(event, *, dedupe_key=None):
        published.append((event, dedupe_key))

    monkeypatch.setattr(ras.realtime_publisher, "publish_threadsafe", publish_threadsafe)
    return published


def _action(make, *, status=ActionStatus.RUNNING, action_type="self_update", stage=None, progress=None):
    db = make()
    try:
        action = RemoteAction(
            device_id=924, action_type=action_type, status=status,
            payload=json.dumps({"version": "2.1.32", "sha256": TARGET_SHA}),
            created_at=utcnow(), queued_at=utcnow(), execution_timeout_seconds=600,
            stage=stage, progress=progress,
        )
        db.add(action)
        db.commit()
        return action.id
    finally:
        db.close()


def _get(make, action_id):
    db = make()
    try:
        return db.get(RemoteAction, action_id)
    finally:
        db.close()


def _client(make):
    app = FastAPI()
    app.include_router(actions_endpoints.router)

    def override():
        db = make()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    return TestClient(app)


def _progress(client, action_id, body, secret=None):
    headers = {"X-Callback-Secret": compute_callback_token(action_id) if secret is None else secret}
    return client.post(f"/actions/{action_id}/progress", json=body, headers=headers)


# ------------------------------------------------------------------ #
# The progress endpoint                                                #
# ------------------------------------------------------------------ #

def test_progress_needs_the_action_callback_secret(make, events):
    action_id = _action(make)
    client = _client(make)
    assert client.post(f"/actions/{action_id}/progress", json={"stage": "downloading"}).status_code == 401
    assert _progress(client, action_id, {"stage": "downloading"}, secret="nope").status_code == 401
    # A secret for another action does not do.
    assert _progress(client, action_id, {"stage": "downloading"},
                     secret=compute_callback_token(action_id + 1)).status_code == 401
    assert _get(make, action_id).stage is None
    assert events == []


def test_progress_records_stage_percent_and_message(make, events):
    action_id = _action(make)
    resp = _progress(_client(make), action_id,
                     {"stage": "downloading", "percent": 42, "message": "Downloading 49% (3.1 of 6.3 MB)"})
    assert resp.status_code == 200
    body = resp.json()
    assert (body["progress"], body["stage"], body["status"]) == (42, "downloading", "running")
    assert body["result_message"] == "Downloading 49% (3.1 of 6.3 MB)"
    action = _get(make, action_id)
    assert (action.progress, action.stage) == (42, "downloading")


@pytest.mark.parametrize("status", [ActionStatus.SENT, ActionStatus.ACKNOWLEDGED])
def test_progress_moves_a_sent_or_acknowledged_action_to_running(make, events, status):
    action_id = _action(make, status=status)
    resp = _progress(_client(make), action_id, {"stage": "downloading", "percent": 5})
    assert resp.status_code == 200
    action = _get(make, action_id)
    assert action.status == ActionStatus.RUNNING
    assert action.started_at is not None and action.acknowledged_at is not None
    assert action.result_message == "Downloading the update"


@pytest.mark.parametrize("status", [ActionStatus.QUEUED, ActionStatus.COMPLETED, ActionStatus.FAILED,
                                    ActionStatus.CANCELLED, ActionStatus.EXPIRED])
def test_progress_is_refused_outside_sent_acknowledged_running(make, events, status):
    action_id = _action(make, status=status)
    resp = _progress(_client(make), action_id, {"stage": "downloading", "percent": 30})
    assert resp.status_code == 409
    assert _get(make, action_id).progress is None
    assert events == []


def test_progress_for_an_unknown_action_is_404(make, events):
    assert _progress(_client(make), 999, {"stage": "downloading"}).status_code == 404


@pytest.mark.parametrize("body", [
    {"stage": "bogus"},
    {"stage": "downloading", "percent": 101},
    {"stage": "downloading", "percent": -1},
    {"stage": "downloading", "message": "x" * 201},
    {"percent": 10},
])
def test_progress_body_is_validated(make, events, body):
    action_id = _action(make)
    assert _progress(_client(make), action_id, body).status_code == 422


def test_progress_never_moves_backwards(make, events):
    action_id = _action(make)
    client = _client(make)
    _progress(client, action_id, {"stage": "downloading", "percent": 60, "message": "Downloading 73%"})
    # A download retry starts again from 0 bytes: the bar stays.
    resp = _progress(client, action_id, {"stage": "downloading", "percent": 20, "message": "Downloading 20%"})
    assert resp.status_code == 200
    action = _get(make, action_id)
    assert (action.progress, action.stage, action.result_message) == (60, "downloading", "Downloading 73%")

    # A notice without a percent keeps the bar and updates the text.
    _progress(client, action_id, {"stage": "downloading", "message": "Download attempt 1 of 3 failed; retrying"})
    action = _get(make, action_id)
    assert (action.progress, action.result_message) == (60, "Download attempt 1 of 3 failed; retrying")

    _progress(client, action_id, {"stage": "verifying", "percent": 85})
    # A late download report after verifying started changes nothing.
    _progress(client, action_id, {"stage": "downloading", "percent": 79, "message": "late"})
    action = _get(make, action_id)
    assert (action.progress, action.stage) == (85, "verifying")
    assert action.result_message == "Verifying the download"


def test_a_stage_without_percent_starts_at_its_mapped_percent(make, events):
    action_id = _action(make)
    client = _client(make)
    for stage, want in (("downloading", 5), ("verifying", 85), ("installing", 90),
                        ("restarting", 95), ("confirming", 97)):
        _progress(client, action_id, {"stage": stage})
        assert _get(make, action_id).progress == want, stage


def test_progress_below_completion_never_reads_100(make, events):
    action_id = _action(make)
    _progress(_client(make), action_id, {"stage": "installing", "percent": 100})
    assert _get(make, action_id).progress == 99


def test_every_progress_report_is_published_with_progress_and_stage(make, events):
    action_id = _action(make)
    client = _client(make)
    for pct in (5, 12, 20, 34):
        _progress(client, action_id, {"stage": "downloading", "percent": pct})
    _progress(client, action_id, {"stage": "verifying", "percent": 85})

    assert len(events) == 5
    for event, _key in events:
        assert event["type"] == "action_status_changed"
        assert event["data"]["status"] == "running"
        assert "progress" in event["data"] and "stage" in event["data"]
    assert [e["data"]["progress"] for e, _ in events] == [5, 12, 20, 34, 85]
    assert [e["data"]["stage"] for e, _ in events][-1] == "verifying"

    # All within the publisher's dedupe window, none dropped.
    publisher = RealtimeEventPublisher()
    assert [publisher._is_duplicate(key) for _, key in events] == [False] * 5


def test_an_ignored_report_publishes_nothing(make, events):
    action_id = _action(make, stage="verifying", progress=85)
    _progress(_client(make), action_id, {"stage": "downloading", "percent": 70})
    assert events == []


def test_queued_events_carry_progress_and_stage(make, events):
    from app.schemas.remote_action import ActionType, RemoteActionCreate

    db = make()
    try:
        RemoteActionService(db).queue_action(924, RemoteActionCreate(action_type=ActionType.PING))
    finally:
        db.close()
    (event, _), = events
    assert event["type"] == "action_queued"
    assert event["data"]["progress"] is None and event["data"]["stage"] is None


def test_the_response_schema_carries_progress_and_stage(make, events):
    action_id = _action(make, stage="installing", progress=90)
    resp = RemoteActionResponse.model_validate(_get(make, action_id))
    assert (resp.progress, resp.stage) == (90, "installing")
    fresh = RemoteActionResponse.model_validate(_get(make, _action(make, status=ActionStatus.SENT)))
    assert (fresh.progress, fresh.stage) == (None, None)


# ------------------------------------------------------------------ #
# The agent's "initiated" completion, failure, heartbeat completion    #
# ------------------------------------------------------------------ #

def test_the_initiated_completion_keeps_the_agents_progress(make, events):
    action_id = _action(make)
    client = _client(make)
    _progress(client, action_id, {"stage": "downloading", "percent": 30, "message": "Downloading 33%"})
    resp = client.post(f"/actions/{action_id}/complete",
                       json={"result_message": "Self-update to v2.1.32 initiated in background"},
                       headers={"X-Callback-Secret": compute_callback_token(action_id)})
    assert resp.status_code == 200
    action = _get(make, action_id)
    assert action.status == ActionStatus.RUNNING
    assert (action.progress, action.stage, action.result_message) == (30, "downloading", "Downloading 33%")


def test_a_reported_failure_keeps_progress_and_stage(make, events):
    action_id = _action(make)
    client = _client(make)
    _progress(client, action_id, {"stage": "verifying", "percent": 85})
    events.clear()
    resp = client.post(f"/actions/{action_id}/fail",
                       json={"error_message": "checksum mismatch (expected bbbbbbbbbbbb, got 0123456789ab)"},
                       headers={"X-Callback-Secret": compute_callback_token(action_id)})
    assert resp.status_code == 200
    action = _get(make, action_id)
    assert action.status == ActionStatus.FAILED
    assert (action.progress, action.stage) == (85, "verifying")
    assert action.error_message.startswith("checksum mismatch")
    (event, _), = events
    assert event["data"]["status"] == "failed" and event["data"]["stage"] == "verifying"
    # Nothing moves a failed action.
    assert _progress(client, action_id, {"stage": "installing"}).status_code == 409


def test_heartbeat_verification_completes_at_100_without_a_stage(make, events):
    action_id = _action(make, stage="confirming", progress=97)
    db = make()
    try:
        device = db.get(Device, 924)
        device.agent_version, device.agent_sha256 = "2.1.32", TARGET_SHA
        db.commit()
        RemoteActionService(db).verify_self_update_for_device(924)
    finally:
        db.close()
    action = _get(make, action_id)
    assert action.status == ActionStatus.COMPLETED
    assert (action.progress, action.stage) == (100, None)
    (event, _), = events
    assert event["data"]["status"] == "completed" and event["data"]["progress"] == 100


def test_a_heartbeat_after_the_restart_is_confirming(make, events):
    action_id = _action(make, stage="restarting", progress=95)
    db = make()
    try:
        RemoteActionService(db).verify_self_update_for_device(924)  # still 2.1.31
    finally:
        db.close()
    action = _get(make, action_id)
    assert (action.status, action.stage, action.progress) == (ActionStatus.RUNNING, "confirming", 97)
    assert len(events) == 1


def test_a_heartbeat_mid_download_changes_nothing(make, events):
    action_id = _action(make, stage="downloading", progress=40)
    db = make()
    try:
        RemoteActionService(db).verify_self_update_for_device(924)
    finally:
        db.close()
    assert _get(make, action_id).stage == "downloading"
    assert events == []


def test_an_agent_version_change_publishes_device_updated():
    before = {"hostname": "h", "status": "online", "agent_version": "2.1.31", "agent_sha256": "a"}
    assert DeviceHeartbeatService._has_inventory_change(before, {**before, "agent_version": "2.1.32"})
    assert DeviceHeartbeatService._has_inventory_change(before, {**before, "agent_sha256": "b"})
    assert not DeviceHeartbeatService._has_inventory_change(before, dict(before))


# ------------------------------------------------------------------ #
# Command channel: restarting / confirming for any agent              #
# ------------------------------------------------------------------ #

def _note(make, connected):
    db = make()
    try:
        RemoteActionService(db).note_command_channel(924, connected)
    finally:
        db.close()


@pytest.mark.parametrize("status", [ActionStatus.RUNNING, ActionStatus.ACKNOWLEDGED])
def test_channel_drop_then_return_is_restarting_then_confirming(make, events, status):
    action_id = _action(make, status=status)  # a ≤ 2.1.31 agent: no stage of its own
    _note(make, connected=False)
    action = _get(make, action_id)
    assert (action.stage, action.progress) == ("restarting", 95)
    assert action.result_message == "Restarting the agent service"
    _note(make, connected=True)
    action = _get(make, action_id)
    assert (action.stage, action.progress) == ("confirming", 97)
    assert [e["data"]["stage"] for e, _ in events] == ["restarting", "confirming"]
    assert len({key for _, key in events}) == 2


def test_channel_drop_after_installing_is_restarting(make, events):
    action_id = _action(make, stage="installing", progress=90)
    _note(make, connected=False)
    assert _get(make, action_id).stage == "restarting"


def test_channel_drop_while_downloading_is_not_a_restart(make, events):
    action_id = _action(make, stage="downloading", progress=40)
    _note(make, connected=False)
    _note(make, connected=True)
    action = _get(make, action_id)
    assert (action.stage, action.progress) == ("downloading", 40)
    assert events == []


def test_channel_return_without_a_restart_changes_nothing(make, events):
    action_id = _action(make)
    _note(make, connected=True)
    assert _get(make, action_id).stage is None
    assert events == []


@pytest.mark.parametrize("action_type,status", [
    ("restart_agent", ActionStatus.RUNNING),
    ("self_update", ActionStatus.SENT),
    ("self_update", ActionStatus.COMPLETED),
    ("self_update", ActionStatus.FAILED),
])
def test_channel_events_touch_only_a_self_update_in_progress(make, events, action_type, status):
    action_id = _action(make, action_type=action_type, status=status)
    _note(make, connected=False)
    assert _get(make, action_id).stage is None
    assert events == []


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def test_the_channel_route_drives_the_stages(make, events, monkeypatch):
    monkeypatch.setattr(agent_channel_routes, "PRESENCE_GRACE_SECONDS", 3600)
    action_id = _action(make)
    app = FastAPI()
    app.include_router(agent_channel_routes.router)
    url = f"/ws/agent/commands?device_id=924&agent_id={AGENT_ID}"
    with TestClient(app) as client:
        with client.websocket_connect(url) as ws:
            ws.close()  # the old agent's service stops: channel closed
            assert _wait_for(lambda: _get(make, action_id).stage == "restarting")
        with client.websocket_connect(url):
            assert _wait_for(lambda: _get(make, action_id).stage == "confirming")
        agent_channel_routes.cancel_presence_checks()


def test_a_reported_restart_then_heartbeat_completion(make, events):
    """End to end for a 2.1.32 agent: reported stages, channel drop and
    return, heartbeat with the new version."""
    action_id = _action(make, status=ActionStatus.ACKNOWLEDGED)
    client = _client(make)
    for body in ({"stage": "downloading", "percent": 5}, {"stage": "downloading", "percent": 80},
                 {"stage": "verifying", "percent": 85}, {"stage": "installing", "percent": 90},
                 {"stage": "restarting", "percent": 95}):
        assert _progress(client, action_id, body).status_code == 200
    _note(make, connected=False)  # already restarting: nothing new
    _note(make, connected=True)
    db = make()
    try:
        device = db.get(Device, 924)
        device.agent_version, device.agent_sha256 = "2.1.32", TARGET_SHA
        device.last_seen = utcnow() + timedelta(seconds=1)
        db.commit()
        RemoteActionService(db).verify_self_update_for_device(924)
    finally:
        db.close()
    progress = [(e["data"]["stage"], e["data"]["progress"]) for e, _ in events]
    assert progress == [("downloading", 5), ("downloading", 80), ("verifying", 85), ("installing", 90),
                        ("restarting", 95), ("confirming", 97), (None, 100)]
    assert _get(make, action_id).status == ActionStatus.COMPLETED
