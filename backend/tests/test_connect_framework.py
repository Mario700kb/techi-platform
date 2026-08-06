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
        # SSH is not Linux-only. MikroTik exposes it through its connector
        # capability; other platforms may expose it through terminal.
        assert "ssh" in [m.id for m in methods_for("mikrotik", {"connect": ""})]
        assert "ssh" in [m.id for m in methods_for("synology", {"terminal": ""})]

    def test_mikrotik_native_methods_always_present(self):
        ids = [m.id for m in methods_for("mikrotik", None)]
        assert ids[:2] == ["winbox", "webfig"]  # native, priority-ordered
        assert "ssh" not in ids  # ssh needs the connector capability

    def test_ordered_by_priority(self):
        methods = methods_for("proxmox", {"terminal": ""})
        priorities = [m.priority for m in methods]
        assert priorities == sorted(priorities)

    def test_winbox_is_not_gated_to_windows(self):
        """Changed 2026-08-06 (owner request): Winbox 4 has a native macOS build
        and operators here use it on both Windows and macOS, so the old
        requires_client_os="windows" disabled a method that works fine.
        No MikroTik method declares a client-OS requirement now."""
        methods = {m.id: m for m in methods_for("mikrotik", {"connect": ""})}
        assert methods["winbox"].requires_client_os is None
        assert methods["webfig"].requires_client_os is None
        assert methods["ssh"].requires_client_os is None


def _client(monkeypatch, flag_on: bool, platform="mikrotik", capabilities=None,
            local_ip=None, public_ip=None, role="owner", agent_version=None,
            connect_host=None, connect_port=None):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", flag_on)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(id=3, hostname="rb", platform=platform, capabilities=capabilities,
                  local_ip=local_ip, public_ip=public_ip, agent_version=agent_version,
                  connect_host=connect_host, connect_port=connect_port,
                  device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE))
    db.commit()
    app = FastAPI()
    app.include_router(connect_endpoint.router)
    app.dependency_overrides[get_db] = lambda: db
    # role="owner" bypasses require_team_permission (admin/owner always pass);
    # tests that need the permission gate to actually reject pass a lesser role.
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=1, username="m", role=role)
    return TestClient(app)


class TestEndpoint:
    def test_404_when_flag_off(self, monkeypatch):
        client = _client(monkeypatch, flag_on=False)
        assert client.get("/devices/3/connect-methods").status_code == 404

    def test_returns_methods_when_on(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, capabilities={"connect": ""})
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


class TestLaunch:
    def test_404_when_flag_off(self, monkeypatch):
        client = _client(monkeypatch, flag_on=False, local_ip="192.168.88.1")
        assert client.get("/devices/3/connect-methods/winbox/launch").status_code == 404

    def test_network_gear_prefers_public_ip(self, monkeypatch):
        """Changed 2026-08-06 (owner request). This used to assert
        winbox://192.168.88.1 — the LAN address, which is exactly why all three
        MikroTik Connect methods failed for an operator outside that LAN. A
        router IS the NAT device, so the address its heartbeat arrived from is
        the router itself and is reachable."""
        client = _client(monkeypatch, flag_on=True, local_ip="192.168.88.1", public_ip="203.0.113.9")
        r = client.get("/devices/3/connect-methods/winbox/launch")
        assert r.status_code == 200
        assert r.json() == {"url": "winbox://203.0.113.9", "surface": "desktop"}

    def test_non_network_platforms_keep_local_ip_first(self, monkeypatch):
        """The public-IP preference must NOT generalise. For a PC or a NAS the
        observed public_ip is the customer's edge router, not the device."""
        for platform in ("windows", "linux", "synology", "qnap"):
            client = _client(monkeypatch, flag_on=True, platform=platform,
                             capabilities={"terminal": ""},
                             local_ip="10.0.0.5", public_ip="203.0.113.9")
            r = client.get(f"/devices/3/connect-methods/ssh/launch")
            if r.status_code == 200:
                assert r.json()["url"] == "ssh://10.0.0.5", platform

    def test_operator_connect_host_overrides_everything(self, monkeypatch):
        """The office-VPN case: no usable public address, so the operator pins
        the LAN address they actually reach through the tunnel."""
        client = _client(monkeypatch, flag_on=True, local_ip="192.168.88.1",
                         public_ip="203.0.113.9", connect_host="10.126.1.1")
        r = client.get("/devices/3/connect-methods/winbox/launch")
        assert r.json()["url"] == "winbox://10.126.1.1"

    def test_connect_port_is_appended(self, monkeypatch):
        """Winbox moved off 8291 — previously inexpressible."""
        client = _client(monkeypatch, flag_on=True, public_ip="203.0.113.9", connect_port=8292)
        r = client.get("/devices/3/connect-methods/winbox/launch")
        assert r.json()["url"] == "winbox://203.0.113.9:8292"

    def test_connect_port_applies_to_browser_methods_too(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, public_ip="203.0.113.9", connect_port=8293)
        r = client.get("/devices/3/connect-methods/webfig/launch")
        assert r.json()["url"] == "http://203.0.113.9:8293/webfig/"

    def test_ssh_requires_connect_capability(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, local_ip="192.168.88.1")
        assert client.get("/devices/3/connect-methods/ssh/launch").status_code == 404
        client = _client(monkeypatch, flag_on=True, local_ip="192.168.88.1", capabilities={"connect": ""})
        r = client.get("/devices/3/connect-methods/ssh/launch")
        assert r.json()["url"] == "ssh://192.168.88.1"

    def test_webfig_uses_web_path_not_scheme(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, local_ip="192.168.88.1")
        r = client.get("/devices/3/connect-methods/webfig/launch")
        assert r.json() == {"url": "http://192.168.88.1/webfig/", "surface": "browser"}

    def test_falls_back_to_public_ip_when_no_local_ip(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, public_ip="203.0.113.9")
        r = client.get("/devices/3/connect-methods/winbox/launch")
        assert r.json()["url"] == "winbox://203.0.113.9"

    def test_409_when_no_ip_known(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True)
        assert client.get("/devices/3/connect-methods/winbox/launch").status_code == 409

    def test_dedicated_methods_rejected(self, monkeypatch):
        # remote_support / web_terminal keep their own existing flows.
        client = _client(monkeypatch, flag_on=True, platform="windows", local_ip="10.0.0.5")
        assert client.get("/devices/3/connect-methods/remote_support/launch").status_code == 400

    def test_permission_denied_for_unscoped_operator(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, local_ip="192.168.88.1", role="readonly")
        assert client.get("/devices/3/connect-methods/winbox/launch").status_code == 403

    def test_audited(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, local_ip="192.168.88.1")
        client.get("/devices/3/connect-methods/winbox/launch")
        from app.models.audit_log import AuditLog
        # Reach into the same db the app used via dependency override.
        db = client.app.dependency_overrides[get_db]()
        entry = db.query(AuditLog).filter(AuditLog.action == "remote_connect").one()
        assert entry.entity_id == 3
        assert entry.details_json and "winbox" in entry.details_json


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


class TestDrawerVersionBadge:
    """Version Service — reused for every non-Windows platform, not reimplemented."""

    def test_windows_has_no_version_status(self, monkeypatch):
        # Windows uses the classic Drawer's own separate badge mechanism.
        client = _client(monkeypatch, flag_on=True, platform="windows", agent_version="2.1.6")
        b = client.get("/devices/3/drawer").json()
        assert b["version_status"] is None
        assert b["latest_version"] is None

    def test_mikrotik_current_when_matching_registry_version(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, platform="mikrotik",
                          capabilities={"connect": ""}, agent_version="1.0.0")
        b = client.get("/devices/3/drawer").json()
        assert b["reported_version"] == "1.0.0"
        assert b["latest_version"] == "1.0.0"
        assert b["version_status"] == "current"

    def test_mikrotik_outdated_when_older_than_registry_version(self, monkeypatch):
        client = _client(monkeypatch, flag_on=True, platform="mikrotik",
                          capabilities={"connect": ""}, agent_version="0.9.0")
        b = client.get("/devices/3/drawer").json()
        assert b["version_status"] == "outdated"
