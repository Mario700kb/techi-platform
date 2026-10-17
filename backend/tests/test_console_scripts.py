"""Saved PowerShell scripts: the library, versions, and running one inside the
caller's own open console."""
import base64
import hashlib
import json
import re
from datetime import timedelta
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import console_scripts
from app.core.auth import get_current_operator
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import OperatorRole
from app.models.terminal_session import TerminalSession

SCRIPT = "Get-Service Spooler | Select-Object Status, Name\n'it''s done' # quotes, $vars and `backticks`"


def _client(role=OperatorRole.ADMIN.value, operator_id=1):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(id=924, hostname="Mario-Lenovo", platform="windows", device_type=DeviceType.CLIENT,
                  status=DeviceStatus.ONLINE))
    db.commit()
    app = FastAPI()
    app.include_router(console_scripts.router)
    operator = SimpleNamespace(id=operator_id, username="denis", role=role)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def _session(db, sid="a" * 32, operator_id=1, status="active", engine="powershell", device_id=924):
    db.add(TerminalSession(id=sid, device_id=device_id, operator_id=operator_id, operator_username="denis",
                           status=status, engine=engine, operator_ticket_hash="x", agent_ticket_hash="y",
                           expires_at=utcnow() + timedelta(minutes=5)))
    db.commit()
    return sid


def test_the_library_keeps_versions_and_refuses_duplicate_names():
    client, db = _client()
    created = client.post("/console/scripts", json={"name": "  Spooler   status ", "body": SCRIPT + "\r\n"})
    assert created.status_code == 201
    script = created.json()
    assert script["name"] == "Spooler status" and script["version"] == 1 and script["body"] == SCRIPT
    assert client.post("/console/scripts", json={"name": "Spooler status", "body": "x"}).status_code == 409

    same = client.put(f"/console/scripts/{script['id']}", json={"name": "Spooler status", "body": SCRIPT})
    assert same.json()["version"] == 1  # nothing changed, no new version
    changed = client.put(f"/console/scripts/{script['id']}", json={"name": "Spooler status", "body": "Get-Date"})
    assert changed.json()["version"] == 2
    assert [s["name"] for s in client.get("/console/scripts").json()] == ["Spooler status"]
    assert client.delete(f"/console/scripts/{script['id']}").status_code == 204
    actions = [r.action for r in db.query(AuditLog).order_by(AuditLog.id)]
    assert actions == ["console_script_created", "console_script_updated", "console_script_deleted"]


def test_only_admins_manage_scripts():
    client, _ = _client(role=OperatorRole.OPERATOR.value)
    assert client.get("/console/scripts").status_code == 403
    assert client.post("/console/scripts", json={"name": "x", "body": "y"}).status_code == 403


def test_running_a_script_returns_one_line_that_runs_it_exactly():
    client, db = _client()
    sid = _session(db)
    script = client.post("/console/scripts", json={"name": "Spooler status", "body": SCRIPT}).json()
    run = client.post(f"/devices/924/terminal/sessions/{sid}/scripts/{script['id']}")
    assert run.status_code == 200, run.text
    command = run.json()["command"]
    assert "\n" not in command and command.endswith("# TECHI script: Spooler status v1")
    encoded = re.search(r"FromBase64String\('([A-Za-z0-9+/=]+)'\)", command).group(1)
    assert base64.b64decode(encoded).decode("utf-8") == SCRIPT
    assert run.json()["script"]["uses"] == 1

    audit = db.query(AuditLog).filter(AuditLog.action == "console_script_run").one()
    details = json.loads(audit.details_json)
    assert details["session_id"] == sid and details["version"] == 1
    assert details["sha256"] == hashlib.sha256(SCRIPT.encode()).hexdigest()


def test_a_script_runs_only_in_the_callers_own_open_powershell_session():
    client, db = _client()
    script = client.post("/console/scripts", json={"name": "s", "body": "Get-Date"}).json()
    others = _session(db, sid="b" * 32, operator_id=2)
    closed = _session(db, sid="c" * 32, status="closed")
    bash = _session(db, sid="d" * 32, engine="bash")
    elsewhere = _session(db, sid="e" * 32, device_id=924)
    for sid, device in ((others, 924), (closed, 924), (bash, 924), (elsewhere, 1), ("f" * 32, 924)):
        r = client.post(f"/devices/{device}/terminal/sessions/{sid}/scripts/{script['id']}")
        assert r.status_code == 404, sid
    assert db.query(AuditLog).filter(AuditLog.action == "console_script_run").count() == 0


def test_the_seeded_scripts_are_named_once_and_fit_the_limits():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "p4q5r6s7t8u9_console_scripts.py"
    spec = importlib.util.spec_from_file_location("console_scripts_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    names = [name for name, _, _ in module.SEED]
    assert len(names) == len(set(names)) == 5
    for name, description, body in module.SEED:
        console_scripts.ConsoleScriptBody(name=name, description=description, body=body)
        assert "ipconfig /release" not in body  # would cut the console's own connection
