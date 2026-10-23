"""PowerShell in command mode: Windows without a pseudo console (Server 2012
R2 / 2016) gets the console after the same two-factor code, each command a
run_powershell action, the folder carried, the session recorded and limited.
Devices with the full console are not touched."""
import json
import os
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import terminal as terminal_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import OperatorRole
from app.models.remote_action import ActionStatus, RemoteAction
from app.models.terminal_session import TerminalSession
from app.services import powershell_command_mode as cmd
from app.services import terminal_recording
from app.services.mfa_service import MfaService
from app.services.terminal_recording import recording_path

CODE = {"engine": "powershell", "mfa_code": "123456"}


@pytest.fixture()
def recordings(tmp_path, monkeypatch):
    monkeypatch.setattr(terminal_recording, "RECORDING_DIR", tmp_path / "rec")
    return tmp_path / "rec"


def _client(monkeypatch, capabilities=None, status=DeviceStatus.ONLINE, operator_id=1):
    for flag in ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT", "FEATURE_TERMINAL"):
        monkeypatch.setattr(settings, flag, True)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", "device")
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_DEVICE_IDS", "930")
    monkeypatch.setattr(MfaService, "verify", lambda self, operator, code: "totp" if code == "123456" else None)
    monkeypatch.setattr("app.services.action_push.push_action_if_connected", lambda *a, **k: False)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(id=930, hostname="PDC", platform="windows", agent_id="agent_x",
                  os_caption="Microsoft Windows Server 2012 R2 Standard",
                  capabilities=capabilities if capabilities is not None else {"remote_support": ""},
                  device_type=DeviceType.SERVER, status=status))
    db.commit()
    return _api(db, operator_id), db


def _api(db, operator_id=1):
    app = FastAPI()
    app.include_router(terminal_endpoint.router)
    operator = SimpleNamespace(id=operator_id, username="denis" if operator_id == 1 else "mario",
                               role=OperatorRole.ADMIN.value, mfa_enabled=True)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app)


def _finish(db, action_id, raw, status=ActionStatus.COMPLETED):
    action = db.get(RemoteAction, action_id)
    action.status = status
    action.output = raw
    db.commit()


# ── the script and its output ───────────────────────────────────────────────

def test_the_script_runs_in_the_carried_folder_and_reports_first():
    script = cmd.build_script("Get-Service spooler", "C:\\Users\\O'Brien")
    assert "Set-Location -LiteralPath $__techiCwd" in script
    assert "$__techiCwd = 'C:\\Users\\O''Brien'" in script  # quoted, not executable
    assert script.index("Get-Service spooler") < script.index(cmd.END_MARKER)
    # The marker is printed before the output, so a cut output keeps it.
    assert script.index(f'"{cmd.END_MARKER}') < script.index("$__techiOut\n")


def test_the_output_gives_back_the_folder_the_status_and_the_time():
    raw = f"{cmd.END_MARKER} 1 840 C:\\inetpub\r\n\r\nStatus   Name\r\n------   ----\r\nStopped  Spooler\r\n"
    output, failed, ms, cwd = cmd.parse_output(raw)
    assert failed is True and ms == 840 and cwd == "C:\\inetpub"
    assert output.splitlines()[-1] == "Stopped  Spooler" and cmd.END_MARKER not in output
    assert cmd.parse_output("no marker here") == ("no marker here", None, None, None)


# ── sessions ────────────────────────────────────────────────────────────────

def test_windows_without_a_pseudo_console_opens_command_mode_after_the_code(monkeypatch, recordings):
    client, db = _client(monkeypatch)
    assert client.post("/devices/930/terminal/sessions", json={"engine": "powershell"}).status_code == 403
    r = client.post("/devices/930/terminal/sessions", json=CODE)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "command" and body["operator_ws_path"] == ""
    session = db.get(TerminalSession, body["session_id"])
    assert session.mode == "command" and session.status == "active" and session.engine == "powershell"
    assert db.query(RemoteAction).count() == 0  # nothing for the agent until a command
    header = json.loads(recording_path(session.id).read_text().splitlines()[0])
    assert header["title"] == "PDC · PowerShell (command mode)"
    listed = client.get("/devices/930/terminal/sessions").json()
    assert [(s["session_id"], s["mode"]) for s in listed] == [(session.id, "command")]


def test_a_device_with_the_full_console_keeps_it(monkeypatch, recordings):
    client, db = _client(monkeypatch, capabilities={"powershell": "", "remote_support": ""})
    body = client.post("/devices/930/terminal/sessions", json=CODE).json()
    assert body["mode"] == "console" and body["operator_ws_path"].endswith(body["operator_ticket"])
    assert db.get(TerminalSession, body["session_id"]).mode == "agent"
    assert db.query(RemoteAction).one().action_type == "open_terminal"


def test_an_offline_device_cannot_open_command_mode(monkeypatch, recordings):
    client, db = _client(monkeypatch, status=DeviceStatus.OFFLINE)
    r = client.post("/devices/930/terminal/sessions", json=CODE)
    assert r.status_code == 409 and db.query(TerminalSession).count() == 0


# ── commands ────────────────────────────────────────────────────────────────

def test_a_command_runs_as_run_powershell_and_its_result_is_recorded_once(monkeypatch, recordings):
    client, db = _client(monkeypatch)
    sid = client.post("/devices/930/terminal/sessions", json=CODE).json()["session_id"]
    base = f"/devices/930/terminal/sessions/{sid}/commands"
    queued = client.post(base, json={"command": "cd C:\\inetpub; Get-ChildItem", "timeout_seconds": 60})
    assert queued.status_code == 200, queued.text
    action = db.get(RemoteAction, queued.json()["action_id"])
    payload = json.loads(action.payload)
    assert action.action_type == "run_powershell" and payload["timeout_seconds"] == 60 and payload["session_id"] == sid
    assert action.execution_timeout_seconds == 120
    # One at a time: the agent runs one PowerShell action per device.
    assert client.post(base, json={"command": "hostname"}).status_code == 409
    running = client.get(f"{base}/{action.id}").json()
    assert running["done"] is False and running["status"] == "queued"

    _finish(db, action.id, f"{cmd.END_MARKER} 0 120 C:\\inetpub\n\n    Directory: C:\\inetpub\n\nwwwroot\n")
    result = client.get(f"{base}/{action.id}").json()
    assert result["done"] is True and result["failed"] is False and result["cwd"] == "C:\\inetpub"
    assert result["output"].strip().endswith("wwwroot")
    client.get(f"{base}/{action.id}")  # read again: not recorded twice
    events = [json.loads(line) for line in recording_path(sid).read_text().splitlines()[1:]]
    texts = [e[2] for e in events]
    assert any("PS C:\\Windows\\system32> cd C:\\inetpub; Get-ChildItem" in t for t in texts)
    assert sum("wwwroot" in t for t in texts) == 1

    nxt = client.post(base, json={"command": "Get-Location", "cwd": result["cwd"]}).json()
    assert "$__techiCwd = 'C:\\inetpub'" in json.loads(db.get(RemoteAction, nxt["action_id"]).payload)["script"]


def test_a_command_that_never_comes_back_says_so(monkeypatch, recordings):
    client, db = _client(monkeypatch)
    sid = client.post("/devices/930/terminal/sessions", json=CODE).json()["session_id"]
    action_id = client.post(f"/devices/930/terminal/sessions/{sid}/commands", json={"command": "hostname"}).json()["action_id"]
    _finish(db, action_id, None, status=ActionStatus.EXPIRED)
    result = client.get(f"/devices/930/terminal/sessions/{sid}/commands/{action_id}").json()
    assert result["done"] is True and result["failed"] is True and result["error"] == "The device did not answer in time"


def test_only_the_operator_who_opened_it_can_use_the_session(monkeypatch, recordings):
    client, db = _client(monkeypatch)
    sid = client.post("/devices/930/terminal/sessions", json=CODE).json()["session_id"]
    mario = _api(db, operator_id=2)
    assert mario.post(f"/devices/930/terminal/sessions/{sid}/commands", json={"command": "whoami"}).status_code == 404
    assert mario.post(f"/devices/930/terminal/sessions/{sid}/close").status_code == 404


def test_an_idle_session_closes_and_refuses_commands(monkeypatch, recordings):
    client, db = _client(monkeypatch)
    sid = client.post("/devices/930/terminal/sessions", json=CODE).json()["session_id"]
    session = db.get(TerminalSession, sid)
    from datetime import timedelta

    session.started_at = session.started_at - timedelta(minutes=20)
    db.commit()
    old = time.time() - 16 * 60
    os.utime(recording_path(sid), (old, old))
    r = client.post(f"/devices/930/terminal/sessions/{sid}/commands", json={"command": "hostname"})
    assert r.status_code == 410 and "idle" in r.json()["detail"]
    db.refresh(session)
    assert session.status == "closed" and session.disconnect_reason == "idle_timeout"


def test_ending_the_session(monkeypatch, recordings):
    client, db = _client(monkeypatch)
    sid = client.post("/devices/930/terminal/sessions", json=CODE).json()["session_id"]
    assert client.post(f"/devices/930/terminal/sessions/{sid}/close").status_code == 204
    assert db.get(TerminalSession, sid).disconnect_reason == "operator_closed"
    assert client.post(f"/devices/930/terminal/sessions/{sid}/commands", json={"command": "hostname"}).status_code == 410
