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


def _client(monkeypatch, platform="mikrotik", capabilities=None, operator_id=1):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
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
