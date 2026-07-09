"""Phase 7 — Connect Framework (capability-driven connection methods)."""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import connect as connect_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.platform_core.connect import methods_for


class TestMetadata:
    def test_windows_has_remote_support_without_capabilities(self):
        # Windows reports no capabilities dict; its native method is still available.
        ids = [m.id for m in methods_for("windows", None)]
        assert ids == ["remote_support"]

    def test_linux_terminal_gated_by_capability(self):
        with_term = [m.id for m in methods_for("linux", {"terminal": ""})]
        assert "web_terminal" in with_term and "ssh" in with_term
        without = [m.id for m in methods_for("linux", {})]
        assert without == []  # no terminal capability → no methods

    def test_ssh_is_generic_not_linux_only(self):
        # Any platform reporting `terminal` exposes SSH.
        assert "ssh" in [m.id for m in methods_for("mikrotik", {"terminal": ""})]
        assert "ssh" in [m.id for m in methods_for("synology", {"terminal": ""})]

    def test_mikrotik_native_methods_always_present(self):
        ids = [m.id for m in methods_for("mikrotik", None)]
        assert ids[:2] == ["winbox", "webfig"]  # native, priority-ordered
        assert "ssh" not in ids  # ssh needs the terminal capability

    def test_ordered_by_priority(self):
        methods = methods_for("proxmox", {"terminal": ""})
        priorities = [m.priority for m in methods]
        assert priorities == sorted(priorities)


def _client(monkeypatch, flag_on: bool, platform="mikrotik", capabilities=None):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", flag_on)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(id=3, hostname="rb", platform=platform, capabilities=capabilities,
                  device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE))
    db.commit()
    app = FastAPI()
    app.include_router(connect_endpoint.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=1, username="m")
    return TestClient(app)


class TestEndpoint:
    def test_404_when_flag_off(self, monkeypatch):
        client = _client(monkeypatch, flag_on=False)
        assert client.get("/devices/3/connect-methods").status_code == 404

    def test_returns_methods_when_on(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, capabilities={"terminal": ""})
        r = client.get("/devices/3/connect-methods")
        assert r.status_code == 200
        body = r.json()
        assert body["platform"] == "mikrotik"
        ids = [m["id"] for m in body["methods"]]
        assert ids[0] == "winbox" and "ssh" in ids

    def test_null_platform_is_windows(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, platform=None)
        r = client.get("/devices/3/connect-methods")
        assert r.json()["platform"] == "windows"
        assert [m["id"] for m in r.json()["methods"]] == ["remote_support"]


class TestDrawerMeta:
    def test_404_when_flag_off(self, monkeypatch):
        assert _client(monkeypatch, flag_on=False).get("/devices/3/drawer").status_code == 404

    def test_windows_no_caps_shows_remote_support_and_full_actions(self, monkeypatch):
        # Windows (no reported capabilities) → declared surface: Remote Support
        # tab on, no capability tabs (single Management), full action set.
        client = _client(monkeypatch, flag_on=True, platform="windows", capabilities=None)
        b = client.get("/devices/3/drawer").json()
        assert b["platform"] == "windows"
        assert b["remote_support"] is True
        action_ids = {a["id"] for a in b["actions"]}
        assert {"ping", "restart_agent", "restart_device", "sync_rustdesk",
                "reinstall_rustdesk", "deploy_remote_support"} <= action_ids

    def test_linux_caps_drive_tabs_and_hide_remote_support(self, monkeypatch):
        caps = {"systemd": "", "services": "", "processes": "", "docker": "",
                "logs": "", "journal": "", "interfaces": "", "terminal": ""}
        client = _client(monkeypatch, flag_on=True, platform="linux", capabilities=caps)
        b = client.get("/devices/3/drawer").json()
        assert b["remote_support"] is False and b["terminal"] is True
        assert b["capability_tabs"] == ["services", "processes", "docker", "logs", "network"]
        action_ids = {a["id"] for a in b["actions"]}
        assert "open_terminal" in action_ids
        assert not ({"sync_rustdesk", "deploy_remote_support"} & action_ids)
        # SSH/terminal Connect methods present, registry-driven.
        assert "ssh" in {m["id"] for m in b["connect_methods"]}
