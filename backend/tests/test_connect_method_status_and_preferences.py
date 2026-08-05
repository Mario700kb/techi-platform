"""Sections D/E/F/G/I — Connect method credential-aware status + per-operator
default Connect method preferences. Builds on the existing Connect Framework
(test_connect_framework.py covers pure metadata; this file covers the new
status/credential/preference wiring layered on top of it)."""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.vault_cipher as vault_cipher
import app.models  # noqa: F401
from app.api.v1.endpoints import connect as connect_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.operator import Operator, OperatorRole
from app.schemas.vault import VaultCredentialCreate
from app.services.vault_service import VaultService


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _client(monkeypatch, platform="mikrotik", capabilities=None, operator_id=1,
            terminal_enabled=True):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
    # Embedded methods (Embedded SSH / Embedded Terminal) are honestly gated
    # by FEATURE_TERMINAL + its rollout scope (same gates the terminal
    # endpoints enforce); enable fleet-wide here — including FEATURE_TERMINAL's
    # flag dependencies (LINUX/VAULT, see flags.FEATURE_DEPENDENCIES) — so
    # credential-status tests exercise the credential axis, not the
    # feature-gate axis.
    monkeypatch.setattr(settings, "FEATURE_LINUX", terminal_enabled)
    monkeypatch.setattr(settings, "FEATURE_VAULT", terminal_enabled)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL", terminal_enabled)
    # Embedded SSH has its own flag (RISK-SSH-001); these cases assert the
    # terminal-stack gating, so it follows the same switch.
    monkeypatch.setattr(settings, "FEATURE_SSH", terminal_enabled)
    monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", "fleet" if terminal_enabled else "none")
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_connection, _):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=3, hostname="rb", platform=platform, capabilities=capabilities or {"connect": ""},
        device_type=DeviceType.UNASSIGNED, status=DeviceStatus.OFFLINE,
    ))
    db.add(Operator(id=1, username="m", email="m@example.com", hashed_password="x", role=OperatorRole.OWNER.value))
    db.add(Operator(id=2, username="other", email="other@example.com", hashed_password="x", role=OperatorRole.OWNER.value))
    db.commit()
    app = FastAPI()
    app.include_router(connect_endpoint.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=operator_id, username="m", role="owner")
    return TestClient(app), db


def _add_credential(db, **overrides):
    data = dict(name="cred", credential_type="winbox", scope_type="global", username="admin", secret="hunter2")
    data.update(overrides)
    return VaultService(db).create(VaultCredentialCreate(**data), created_by="tester")


class TestMethodStatus:
    def test_winbox_credential_required_when_no_credential_exists(self, monkeypatch):
        client, _ = _client(monkeypatch)
        r = client.get("/devices/3/connect-methods")
        methods = {m["id"]: m for m in r.json()["methods"]}
        assert methods["winbox"]["status"] == "credential_required"
        assert methods["winbox"]["status_reason"] == "No compatible credential configured"
        assert methods["winbox"]["credential_source"] is None

    def test_winbox_ready_once_a_winbox_credential_resolves(self, monkeypatch):
        client, db = _client(monkeypatch)
        _add_credential(db, credential_type="winbox", scope_type="global")
        r = client.get("/devices/3/connect-methods")
        methods = {m["id"]: m for m in r.json()["methods"]}
        assert methods["winbox"]["status"] == "ready"
        assert methods["winbox"]["credential_source"] == "global"

    def test_webfig_credential_required_by_default(self, monkeypatch):
        client, _ = _client(monkeypatch)
        r = client.get("/devices/3/connect-methods")
        methods = {m["id"]: m for m in r.json()["methods"]}
        assert methods["webfig"]["status"] == "credential_required"

    def test_webfig_ready_via_purpose_marked_generic_credential(self, monkeypatch):
        client, db = _client(monkeypatch)
        _add_credential(
            db, name="webfig-generic", credential_type="generic_username_password",
            scope_type="global", purpose="WebFig admin login",
        )
        r = client.get("/devices/3/connect-methods")
        methods = {m["id"]: m for m in r.json()["methods"]}
        assert methods["webfig"]["status"] == "ready"

    def test_ssh_credential_required_when_no_ssh_type_credential(self, monkeypatch):
        client, db = _client(monkeypatch)
        # A winbox credential exists but SSH must NOT treat it as usable.
        _add_credential(db, credential_type="winbox", scope_type="global")
        r = client.get("/devices/3/connect-methods")
        methods = {m["id"]: m for m in r.json()["methods"]}
        assert methods["ssh"]["status"] == "credential_required"

    def test_native_methods_without_credential_concept_are_always_ready(self, monkeypatch):
        client, _ = _client(monkeypatch, platform="windows", capabilities=None)
        r = client.get("/devices/3/connect-methods")
        methods = {m["id"]: m for m in r.json()["methods"]}
        assert methods["remote_support"]["status"] == "ready"


class TestPreferredMethodDefault:
    def test_defaults_to_registry_priority_when_ready(self, monkeypatch):
        # Winbox is priority 10 (first) for mikrotik and has no credential
        # requirement issue here since we give it one.
        client, db = _client(monkeypatch)
        _add_credential(db, credential_type="winbox", scope_type="global")
        r = client.get("/devices/3/connect-methods")
        body = r.json()
        assert body["preferred_method_id"] == "winbox"
        assert body["configured_preference_id"] is None

    def test_falls_back_to_first_ready_when_registry_default_not_ready(self, monkeypatch):
        # Winbox (priority 10, registry default) has no credential; SSH
        # (priority 30) does — preferred must fall back to a Ready method,
        # never silently point at an unusable one.
        client, db = _client(monkeypatch)
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        r = client.get("/devices/3/connect-methods")
        body = r.json()
        methods = {m["id"]: m for m in body["methods"]}
        assert methods["winbox"]["status"] == "credential_required"
        assert methods["ssh"]["status"] == "ready"
        assert body["preferred_method_id"] == "ssh"


class TestConnectPreferences:
    def test_set_preference_makes_it_the_preferred_method_when_ready(self, monkeypatch):
        client, db = _client(monkeypatch)
        _add_credential(db, credential_type="winbox", scope_type="global")
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        r = client.put("/connect-preferences", json={"platform": "mikrotik", "method_id": "ssh"})
        assert r.status_code == 200, r.text

        r2 = client.get("/devices/3/connect-methods")
        body = r2.json()
        assert body["preferred_method_id"] == "ssh"
        assert body["configured_preference_id"] == "ssh"

    def test_configured_preference_shown_even_when_not_currently_ready(self, monkeypatch):
        client, db = _client(monkeypatch)
        # Operator prefers SSH but no SSH credential exists yet; Winbox does.
        _add_credential(db, credential_type="winbox", scope_type="global")
        client.put("/connect-preferences", json={"platform": "mikrotik", "method_id": "ssh"})

        r = client.get("/devices/3/connect-methods")
        body = r.json()
        assert body["configured_preference_id"] == "ssh"
        # Falls back to a method that's actually usable right now.
        assert body["preferred_method_id"] == "winbox"

    def test_device_override_beats_platform_default(self, monkeypatch):
        client, db = _client(monkeypatch)
        _add_credential(db, credential_type="winbox", scope_type="global")
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        client.put("/connect-preferences", json={"platform": "mikrotik", "method_id": "winbox"})
        client.put("/connect-preferences", json={"platform": "mikrotik", "method_id": "ssh", "device_id": 3})

        r = client.get("/devices/3/connect-methods")
        assert r.json()["preferred_method_id"] == "ssh"

    def test_reset_preference_reverts_to_registry_default(self, monkeypatch):
        client, db = _client(monkeypatch)
        _add_credential(db, credential_type="winbox", scope_type="global")
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        client.put("/connect-preferences", json={"platform": "mikrotik", "method_id": "ssh"})
        assert client.get("/devices/3/connect-methods").json()["preferred_method_id"] == "ssh"

        r = client.request("DELETE", "/connect-preferences", json={"platform": "mikrotik"})
        assert r.status_code == 204

        body = client.get("/devices/3/connect-methods").json()
        assert body["configured_preference_id"] is None
        assert body["preferred_method_id"] == "winbox"

    def test_preferences_are_not_global_across_operators(self, monkeypatch):
        client1, db = _client(monkeypatch, operator_id=1)
        _add_credential(db, credential_type="winbox", scope_type="global")
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        client1.put("/connect-preferences", json={"platform": "mikrotik", "method_id": "ssh"})

        # A second operator, same DB, never set a preference — must NOT
        # inherit operator 1's choice (Section G: "not global").
        app2 = FastAPI()
        app2.include_router(connect_endpoint.router)
        app2.dependency_overrides[get_db] = lambda: db
        app2.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=2, username="other", role="owner")
        client2 = TestClient(app2)

        body = client2.get("/devices/3/connect-methods").json()
        assert body["configured_preference_id"] is None
        assert body["preferred_method_id"] == "winbox"  # registry default, not operator 1's ssh choice

    def test_list_preferences_returns_only_calling_operators_rows(self, monkeypatch):
        client, db = _client(monkeypatch, operator_id=1)
        client.put("/connect-preferences", json={"platform": "mikrotik", "method_id": "ssh"})
        client.put("/connect-preferences", json={"platform": "linux", "method_id": "web_terminal"})
        r = client.get("/connect-preferences")
        assert r.status_code == 200
        platforms = {p["platform"] for p in r.json()}
        assert platforms == {"mikrotik", "linux"}


class TestMockupFidelity:
    """Approved V3 Connect mockup — categorized menu metadata, operator-OS
    awareness, honest embedded gating, and OS-specific platform defaults."""

    def test_mikrotik_exposes_winbox_ssh_webfig_with_menu_metadata(self, monkeypatch):
        client, _ = _client(monkeypatch)
        methods = {m["id"]: m for m in client.get("/devices/3/connect-methods").json()["methods"]}
        assert set(methods) == {"winbox", "ssh", "webfig"}
        assert methods["winbox"]["category"] == "desktop_app"
        assert methods["winbox"]["transport"] == "Desktop app"
        assert methods["winbox"]["requires_client_os"] == "windows"
        assert methods["ssh"]["label"] == "Embedded SSH"
        assert methods["ssh"]["category"] == "available"
        assert methods["ssh"]["embedded"] is True
        assert methods["webfig"]["category"] == "web"
        assert methods["webfig"]["transport"] == "Browser"

    def test_winbox_visible_but_unavailable_on_macos_operator(self, monkeypatch):
        # Never silently hidden: the method row stays in the list with an
        # explicit unavailable status + reason.
        client, _ = _client(monkeypatch)
        methods = {m["id"]: m for m in client.get("/devices/3/connect-methods?client_os=macos").json()["methods"]}
        assert methods["winbox"]["status"] == "unavailable"
        assert "unavailable on this operating system" in methods["winbox"]["status_reason"].lower()

    def test_winbox_ready_on_windows_operator_with_credential(self, monkeypatch):
        client, db = _client(monkeypatch)
        _add_credential(db, credential_type="winbox", scope_type="global")
        methods = {m["id"]: m for m in client.get("/devices/3/connect-methods?client_os=windows").json()["methods"]}
        assert methods["winbox"]["status"] == "ready"
        assert methods["winbox"]["credential_source"] == "global"

    def test_embedded_methods_unavailable_when_terminal_flag_off(self, monkeypatch):
        client, db = _client(monkeypatch, terminal_enabled=False)
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        methods = {m["id"]: m for m in client.get("/devices/3/connect-methods").json()["methods"]}
        # Credential exists, but the Terminal stack the embedded session needs
        # is off — the method must say so instead of failing on click.
        assert methods["ssh"]["status"] == "unavailable"
        assert "not enabled" in methods["ssh"]["status_reason"].lower()

    def test_embedded_methods_unavailable_outside_rollout_scope(self, monkeypatch):
        client, db = _client(monkeypatch)
        monkeypatch.setattr(settings, "FEATURE_TERMINAL_SCOPE", "device")
        monkeypatch.setattr(settings, "FEATURE_TERMINAL_ALLOWED_DEVICE_IDS", "999")
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        methods = {m["id"]: m for m in client.get("/devices/3/connect-methods").json()["methods"]}
        assert methods["ssh"]["status"] == "unavailable"

    def test_mikrotik_macos_defaults_to_embedded_ssh_then_webfig(self, monkeypatch):
        # macOS operator: Winbox can never be the default; Embedded SSH wins
        # when Ready, WebFig when it isn't.
        client, db = _client(monkeypatch)
        ssh_cred = _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        _add_credential(db, name="webfig-cred", credential_type="webfig", scope_type="global")
        assert client.get("/devices/3/connect-methods?client_os=macos").json()["preferred_method_id"] == "ssh"

        VaultService(db).delete(ssh_cred, "tester", force=True)  # remove the SSH credential
        body = client.get("/devices/3/connect-methods?client_os=macos").json()
        assert body["preferred_method_id"] == "webfig"

    def test_mikrotik_windows_defaults_to_winbox(self, monkeypatch):
        client, db = _client(monkeypatch)
        _add_credential(db, credential_type="winbox", scope_type="global")
        _add_credential(db, name="ssh-cred", credential_type="ssh_key", scope_type="global", secret="key")
        assert client.get("/devices/3/connect-methods?client_os=windows").json()["preferred_method_id"] == "winbox"

    def test_windows_remote_support_unchanged_and_default(self, monkeypatch):
        client, _ = _client(monkeypatch, platform="windows", capabilities=None, terminal_enabled=False)
        body = client.get("/devices/3/connect-methods?client_os=macos").json()
        methods = {m["id"]: m for m in body["methods"]}
        assert set(methods) == {"remote_support"}
        assert methods["remote_support"]["status"] == "ready"
        assert body["preferred_method_id"] == "remote_support"

    def test_linux_embedded_terminal_is_default(self, monkeypatch):
        client, _ = _client(monkeypatch, platform="linux", capabilities={"terminal": ""})
        body = client.get("/devices/3/connect-methods").json()
        methods = {m["id"]: m for m in body["methods"]}
        assert methods["web_terminal"]["label"] == "Embedded Terminal"
        assert methods["web_terminal"]["status"] == "ready"
        assert body["preferred_method_id"] == "web_terminal"

    def test_launch_url_never_contains_credential_material(self, monkeypatch):
        client, db = _client(monkeypatch)
        device = db.query(Device).filter(Device.id == 3).one()
        device.local_ip = "192.168.88.1"
        db.commit()
        _add_credential(db, credential_type="winbox", scope_type="global",
                        username="techi-admin", secret="super-secret-pass")
        r = client.get("/devices/3/connect-methods/winbox/launch")
        assert r.status_code == 200
        url = r.json()["url"]
        assert url == "winbox://192.168.88.1"
        assert "techi-admin" not in url and "super-secret-pass" not in url


class TestConnectStatusBatch:
    """GET /connect-status — the Device Catalog's per-row button state."""

    def _add_device(self, db, device_id, platform, capabilities=None):
        db.add(Device(
            id=device_id, hostname=f"d{device_id}", platform=platform,
            capabilities=capabilities, device_type=DeviceType.UNASSIGNED,
            status=DeviceStatus.OFFLINE,
        ))
        db.commit()

    def test_states_across_devices(self, monkeypatch):
        client, db = _client(monkeypatch)  # device 3 = mikrotik {"connect": ""}
        self._add_device(db, 4, "linux", {"terminal": ""})
        self._add_device(db, 5, "linux", {})  # no capability → no methods
        _add_credential(db, credential_type="winbox", scope_type="global")

        r = client.get("/connect-status?device_ids=3,4,5&client_os=windows")
        assert r.status_code == 200
        rows = {row["device_id"]: row for row in r.json()}
        assert rows[3]["state"] == "ready"          # winbox credential resolves
        assert rows[3]["preferred_method_id"] == "winbox"
        assert rows[4]["state"] == "ready"          # Embedded Terminal (fleet rollout)
        assert rows[4]["preferred_method_id"] == "web_terminal"
        assert rows[5]["state"] == "unavailable"
        assert rows[5]["method_count"] == 0

    def test_credential_required_state(self, monkeypatch):
        client, _ = _client(monkeypatch, terminal_enabled=False)
        r = client.get("/connect-status?device_ids=3&client_os=macos")
        row = r.json()[0]
        # Winbox (macOS) + Embedded SSH (terminal off) unavailable; WebFig
        # needs a credential → the aggregate row state is credential_required.
        assert row["state"] == "credential_required"

    def test_404_when_flag_off(self, monkeypatch):
        client, _ = _client(monkeypatch)
        monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", False)
        assert client.get("/connect-status?device_ids=3").status_code == 404

    def test_caps_id_count(self, monkeypatch):
        client, _ = _client(monkeypatch)
        too_many = ",".join(str(i) for i in range(201))
        assert client.get(f"/connect-status?device_ids={too_many}").status_code == 400
