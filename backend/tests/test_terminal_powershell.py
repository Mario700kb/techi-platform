"""Administrator PowerShell on Windows: two-factor code on every open, the
session forced to PowerShell, recorded, and the recordings listed and served."""
import asyncio
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
from app.api.v1.endpoints import terminal as terminal_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import OperatorRole
from app.models.remote_action import RemoteAction
from app.models.terminal_session import TerminalSession
from app.services import terminal_recording
from app.services.mfa_service import MfaService
from app.services.terminal_recording import TerminalRecorder, cleanup_recordings, recording_path
from app.services.terminal_relay import TerminalRelay


@pytest.fixture()
def recordings(tmp_path, monkeypatch):
    monkeypatch.setattr(terminal_recording, "RECORDING_DIR", tmp_path / "rec")
    return tmp_path / "rec"


def _client(monkeypatch, capabilities=None, mfa_enabled=True, platform="windows"):
    for flag in ("FEATURE_PLATFORM_CORE", "FEATURE_LINUX", "FEATURE_VAULT", "FEATURE_TERMINAL"):
        monkeypatch.setattr(settings, flag, True)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", "device")
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_DEVICE_IDS", "924")
    monkeypatch.setattr(MfaService, "verify", lambda self, operator, code: "totp" if code == "123456" else None)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(id=924, hostname="Mario-Lenovo", platform=platform,
                  capabilities=capabilities if capabilities is not None else {"powershell": "", "remote_support": ""},
                  device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE))
    db.commit()
    app = FastAPI()
    app.include_router(terminal_endpoint.router)
    operator = SimpleNamespace(id=1, username="denis", role=OperatorRole.ADMIN.value, mfa_enabled=mfa_enabled)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def _denials(db):
    return [json.loads(r.details_json)["reason"] for r in db.query(AuditLog).filter(AuditLog.action == "terminal_session_denied")]


def test_an_operator_without_two_factor_cannot_open_powershell(monkeypatch):
    client, db = _client(monkeypatch, mfa_enabled=False)
    r = client.post("/devices/924/terminal/sessions", json={"engine": "powershell", "mfa_code": "123456"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "mfa_not_enabled"
    assert _denials(db) == ["mfa_not_enabled"]
    assert db.query(TerminalSession).count() == 0


@pytest.mark.parametrize("code", [None, "", "000000"])
def test_a_missing_or_wrong_code_is_refused_and_audited(monkeypatch, code):
    client, db = _client(monkeypatch)
    r = client.post("/devices/924/terminal/sessions", json={"engine": "powershell", "mfa_code": code})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "mfa_invalid"
    assert _denials(db) == ["mfa_invalid"]


def test_a_windows_device_always_opens_powershell_after_the_code(monkeypatch):
    client, db = _client(monkeypatch)
    # Asking for bash does not skip the check on a Windows device ...
    assert client.post("/devices/924/terminal/sessions", json={"engine": "bash"}).status_code == 403
    # ... and with the code the session is PowerShell whatever was asked.
    r = client.post("/devices/924/terminal/sessions", json={"engine": "bash", "mfa_code": "123456"})
    assert r.status_code == 200, r.text
    session = db.get(TerminalSession, r.json()["session_id"])
    assert session.engine == "powershell"
    action = db.query(RemoteAction).one()
    payload = json.loads(action.payload)
    assert payload.get("engine", payload.get("parameters", {}).get("engine")) == "powershell"


def test_a_windows_device_without_the_new_agent_has_no_console(monkeypatch):
    client, _ = _client(monkeypatch, capabilities={"remote_support": ""})
    r = client.post("/devices/924/terminal/sessions", json={"engine": "powershell", "mfa_code": "123456"})
    assert r.status_code == 400


# ── recording ───────────────────────────────────────────────────────────────

SESSION = "0123456789abcdef0123456789abcdef"


def test_the_recording_holds_the_console_output_as_asciicast(recordings):
    recorder = TerminalRecorder(SESSION, title="PowerShell on Mario-Lenovo by denis")
    recorder.output(b"PS C:\\Windows\\system32> ")
    recorder.output("Get-Service\r\n")
    recorder.resize(160, 40)
    recorder.close()
    lines = (recordings / f"{SESSION}.cast").read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    assert header["version"] == 2 and header["title"] == "PowerShell on Mario-Lenovo by denis"
    assert [json.loads(line)[1:] for line in lines[1:]] == [
        ["o", "PS C:\\Windows\\system32> "], ["o", "Get-Service\r\n"], ["r", "160x40"],
    ]


def test_a_recording_stops_at_its_size_cap(recordings, monkeypatch):
    monkeypatch.setattr(terminal_recording, "RECORDING_MAX_BYTES", 400)
    recorder = TerminalRecorder(SESSION, title="t")
    for _ in range(50):
        recorder.output("x" * 50)
    recorder.close()
    text = (recordings / f"{SESSION}.cast").read_text()
    assert len(text) < 600 and "[recording limit reached]" in text


def test_a_recording_path_never_leaves_its_directory(recordings):
    assert recording_path("../../etc/passwd") is None
    assert recording_path(SESSION.upper()) is None
    assert recording_path(SESSION) == recordings / f"{SESSION}.cast"


def test_old_recordings_are_removed(recordings):
    recordings.mkdir()
    old, new = recordings / f"{'a' * 32}.cast", recordings / f"{'b' * 32}.cast"
    old.write_text("{}")
    new.write_text("{}")
    import os
    stale = (datetime.now(timezone.utc) - timedelta(days=200)).timestamp()
    os.utime(old, (stale, stale))
    assert cleanup_recordings() == 1
    assert not old.exists() and new.exists()


def test_the_relay_records_device_output_and_resizes_only():
    seen = []
    recorder = SimpleNamespace(output=lambda d: seen.append(("o", d)), resize=lambda c, r: seen.append(("r", c, r)),
                               close=lambda: seen.append(("closed",)))
    TerminalRelay._record(recorder, {"bytes": b"output"}, is_operator=False)
    TerminalRelay._record(recorder, {"bytes": b"typed secret"}, is_operator=True)
    TerminalRelay._record(recorder, {"text": '{"t":"resize","cols":120,"rows":30}'}, is_operator=True)
    relay = TerminalRelay()

    async def run():
        await relay.start_recording(SESSION, recorder)
        await relay.close(SESSION)

    asyncio.run(run())
    assert seen == [("o", b"output"), ("r", 120, 30), ("closed",)]


def test_sessions_and_their_recordings_are_listed_and_served(monkeypatch, recordings):
    client, db = _client(monkeypatch)
    r = client.post("/devices/924/terminal/sessions", json={"engine": "powershell", "mfa_code": "123456"})
    session_id = r.json()["session_id"]
    recorder = TerminalRecorder(session_id, title="t")
    recorder.output("PS> whoami\r\nnt authority\\system\r\n")
    recorder.close()
    db.get(TerminalSession, session_id).recording_path = str(recorder.path)
    db.commit()

    listed = client.get("/devices/924/terminal/sessions").json()
    assert listed[0]["session_id"] == session_id and listed[0]["engine"] == "powershell"
    assert listed[0]["recording_bytes"] > 0

    served = client.get(f"/devices/924/terminal/sessions/{session_id}/recording")
    assert served.status_code == 200 and "nt authority" in served.text
    assert db.query(AuditLog).filter(AuditLog.action == "terminal_recording_viewed").count() == 1
    assert client.get(f"/devices/1/terminal/sessions/{session_id}/recording").status_code == 404
    assert client.get("/devices/924/terminal/sessions/..%2F..%2Fx/recording").status_code == 404
