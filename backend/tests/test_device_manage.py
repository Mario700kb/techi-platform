"""Ending a process, controlling a service and uninstalling an app from the
device page: only what the device reported, never the agent, Remote Support
or core Windows, only on agents that know the action, an uninstall only by an
administrator with a current two-factor code."""
import json
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import actions as actions_endpoint
from app.api.v1.endpoints import device_manage
from app.core.auth import get_current_operator, get_operator_scope
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.models.operator import OperatorRole
from app.models.remote_action import RemoteAction
from app.services.mfa_service import MfaService

PROCESSES = [{"pid": 6380, "name": "explorer.exe", "memory_mb": 221}, {"pid": 9764, "name": "chrome.exe"},
             {"pid": 700, "name": "lsass.exe"}]
SERVICES = [{"name": "Spooler", "display_name": "Print Spooler", "status": "Running"},
            {"name": "wuauserv", "display_name": "Windows Update", "status": "Stopped"},
            {"name": "TechiAgent", "display_name": "TECHI Agent", "status": "Running"},
            {"name": "Schedule", "display_name": "Task Scheduler", "status": "Stopped"}]
SEVEN_ZIP_KEY = r"HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\{23170F69-40C1-2702-2301-000001000000}"
SOFTWARE = [
    {"name": "7-Zip 23.01", "uninstall": "msi", "uninstall_key": SEVEN_ZIP_KEY},
    {"name": "Google Chrome"},
    {"name": "TECHI Agent", "uninstall": "msi", "uninstall_key": r"HKEY_LOCAL_MACHINE\Software\X\{1}"},
]


def _setup(monkeypatch, *, role=OperatorRole.ADMIN.value, agent_version="2.1.41", platform="windows"):
    pushed = []
    monkeypatch.setattr(device_manage, "push_action_if_connected", lambda device_id, action, svc: pushed.append(action.id))
    monkeypatch.setattr(device_manage, "get_operator_permissions", lambda operator, db: None)
    monkeypatch.setattr(MfaService, "verify", lambda self, operator, code: "totp" if code == "123456" else None)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(id=983, hostname="Mario-Lenovo", platform=platform, agent_id="agent_x", agent_version=agent_version,
                  device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE))
    db.add(DeviceInventory(device_id=983, processes_json=json.dumps(PROCESSES), services_json=json.dumps(SERVICES),
                           software_json=json.dumps(SOFTWARE)))
    db.commit()
    api = FastAPI()
    api.include_router(device_manage.router)
    api.include_router(actions_endpoint.router)
    operator = SimpleNamespace(id=1, username="denis", role=role, mfa_enabled=True)
    api.dependency_overrides[get_db] = lambda: db
    api.dependency_overrides[get_current_operator] = lambda: operator
    api.dependency_overrides[get_operator_scope] = lambda: None
    return TestClient(api), db, pushed


def _params(db, action_id):
    return json.loads(db.get(RemoteAction, action_id).payload)


# ── processes ───────────────────────────────────────────────────────────────

def test_an_operator_ends_a_listed_process_and_it_is_pushed(monkeypatch):
    client, db, pushed = _setup(monkeypatch, role=OperatorRole.OPERATOR.value)
    r = client.post("/devices/983/processes/kill", json={"pid": 9764, "name": "chrome.exe"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["action_type"] == "kill_process" and body["execution_timeout_seconds"] == 60
    assert _params(db, body["id"]) == {"pid": 9764, "name": "chrome.exe"}
    assert pushed == [body["id"]]
    audit = db.query(AuditLog).filter(AuditLog.action == "action_queued").one()
    assert json.loads(audit.details_json)["pid"] == 9764


def test_a_process_the_device_did_not_report_or_a_protected_one_is_refused(monkeypatch):
    client, db, _ = _setup(monkeypatch)
    assert client.post("/devices/983/processes/kill", json={"pid": 9765, "name": "chrome.exe"}).status_code == 409
    assert client.post("/devices/983/processes/kill", json={"pid": 9764, "name": "explorer.exe"}).status_code == 409
    assert client.post("/devices/983/processes/kill", json={"pid": 700, "name": "lsass.exe"}).status_code == 403
    assert client.post("/devices/983/processes/kill", json={"pid": 4, "name": "System"}).status_code == 422
    assert db.query(RemoteAction).count() == 0


def test_two_kills_of_different_processes_may_run_together_but_not_twice_the_same(monkeypatch):
    client, db, _ = _setup(monkeypatch)
    assert client.post("/devices/983/processes/kill", json={"pid": 9764, "name": "chrome.exe"}).status_code == 200
    again = client.post("/devices/983/processes/kill", json={"pid": 9764, "name": "chrome.exe"})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "action_conflict"
    assert client.post("/devices/983/processes/kill", json={"pid": 6380, "name": "explorer.exe"}).status_code == 200


# ── services ────────────────────────────────────────────────────────────────

def test_services_start_stop_restart_but_core_ones_only_start(monkeypatch):
    client, db, _ = _setup(monkeypatch, role=OperatorRole.OPERATOR.value)
    r = client.post("/devices/983/services/control", json={"name": "Spooler", "operation": "restart"})
    assert r.status_code == 200, r.text
    assert _params(db, r.json()["id"]) == {"name": "Spooler", "operation": "restart"}
    assert r.json()["execution_timeout_seconds"] == 180
    assert client.post("/devices/983/services/control", json={"name": "TechiAgent", "operation": "stop"}).status_code == 403
    assert client.post("/devices/983/services/control", json={"name": "Schedule", "operation": "start"}).status_code == 200
    assert client.post("/devices/983/services/control", json={"name": "NoSuchSvc", "operation": "start"}).status_code == 409
    assert client.post("/devices/983/services/control", json={"name": "Spooler", "operation": "delete"}).status_code == 422


# ── software ────────────────────────────────────────────────────────────────

def test_an_uninstall_needs_an_administrator_and_a_current_code(monkeypatch):
    body = {"name": "7-Zip 23.01", "uninstall_key": SEVEN_ZIP_KEY}
    client, db, _ = _setup(monkeypatch, role=OperatorRole.OPERATOR.value)
    assert client.post("/devices/983/software/uninstall", json={**body, "mfa_code": "123456"}).status_code == 403

    client, db, pushed = _setup(monkeypatch)
    denied = client.post("/devices/983/software/uninstall", json=body)
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "mfa_invalid"
    assert db.query(AuditLog).filter(AuditLog.action == "software_uninstall_denied").count() == 1
    r = client.post("/devices/983/software/uninstall", json={**body, "mfa_code": "123 456"})
    assert r.status_code == 200, r.text
    assert r.json()["action_type"] == "uninstall_software" and r.json()["execution_timeout_seconds"] == 1200
    assert _params(db, r.json()["id"]) == body
    assert pushed == [r.json()["id"]]


def test_only_a_reported_silently_removable_app_other_than_techi_is_uninstalled(monkeypatch):
    client, db, _ = _setup(monkeypatch)
    code = {"mfa_code": "123456"}
    no_silent = client.post("/devices/983/software/uninstall", json={"name": "Google Chrome", "uninstall_key": "x", **code})
    assert no_silent.status_code == 409
    techi = client.post("/devices/983/software/uninstall",
                        json={"name": "TECHI Agent", "uninstall_key": r"HKEY_LOCAL_MACHINE\Software\X\{1}", **code})
    assert techi.status_code == 403
    other_key = client.post("/devices/983/software/uninstall",
                            json={"name": "7-Zip 23.01", "uninstall_key": SEVEN_ZIP_KEY + "x", **code})
    assert other_key.status_code == 409
    assert db.query(RemoteAction).count() == 0


# ── device gates ────────────────────────────────────────────────────────────

def test_an_older_agent_or_a_linux_device_is_refused_with_the_reason(monkeypatch):
    client, _, _ = _setup(monkeypatch, agent_version="2.1.40")
    r = client.post("/devices/983/processes/kill", json={"pid": 9764, "name": "chrome.exe"})
    assert r.status_code == 409 and "2.1.41" in r.json()["detail"]
    client, _, _ = _setup(monkeypatch, platform="linux")
    assert client.post("/devices/983/services/control", json={"name": "Spooler", "operation": "start"}).status_code == 409


def test_the_generic_action_endpoint_cannot_queue_them(monkeypatch):
    client, db, _ = _setup(monkeypatch)
    for action_type in ("kill_process", "service_control", "uninstall_software"):
        r = client.post("/devices/983/actions", json={"action_type": action_type, "parameters": {}})
        assert r.status_code == 422, (action_type, r.status_code)
    assert db.query(RemoteAction).count() == 0
