"""Notification Engine API — flag-gated darkness, channel/rule CRUD, test
send, delivery history, audit-on-mutation."""

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.vault_cipher as vault_cipher
import app.models  # noqa: F401
from app.api.v1.endpoints import notifications as notifications_endpoint
from app.core.auth import get_current_operator
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.operator import OperatorRole
from app.services import notification_channels as channels_module


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _client(monkeypatch, flag_on: bool, role: str = OperatorRole.ADMIN.value):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", flag_on)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    app = FastAPI()
    app.include_router(notifications_endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=role)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    return TestClient(app), db


def _channel_payload(**overrides):
    data = {
        "name": "ops-webhook",
        "channel_type": "webhook",
        "config": {"url": "https://hooks.example.com/techi"},
        "secret": "shh",
    }
    data.update(overrides)
    return data


def test_404_when_flag_off(monkeypatch):
    client, _ = _client(monkeypatch, flag_on=False)
    assert client.get("/channels").status_code == 404
    assert client.get("/rules").status_code == 404
    assert client.get("/deliveries").status_code == 404


def test_create_and_list_channel(monkeypatch):
    client, db = _client(monkeypatch, flag_on=True)
    r = client.post("/channels", json=_channel_payload())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "ops-webhook"
    assert body["has_secret"] is True
    assert "secret" not in body  # never returned

    r = client.get("/channels")
    assert r.status_code == 200
    assert len(r.json()) == 1

    rows = db.query(AuditLog).filter(AuditLog.action == "notification_channel_created").all()
    assert len(rows) == 1


def test_update_channel_rotates_secret(monkeypatch):
    client, db = _client(monkeypatch, flag_on=True)
    channel_id = client.post("/channels", json=_channel_payload()).json()["id"]
    r = client.patch(f"/channels/{channel_id}", json={"enabled": False, "secret": "new-secret"})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    rows = db.query(AuditLog).filter(AuditLog.action == "notification_channel_updated").all()
    assert len(rows) == 1


def test_delete_channel(monkeypatch):
    client, db = _client(monkeypatch, flag_on=True)
    channel_id = client.post("/channels", json=_channel_payload()).json()["id"]
    r = client.delete(f"/channels/{channel_id}")
    assert r.status_code == 204
    assert client.get("/channels").json() == []
    rows = db.query(AuditLog).filter(AuditLog.action == "notification_channel_deleted").all()
    assert len(rows) == 1


def test_unknown_channel_404(monkeypatch):
    client, _ = _client(monkeypatch, flag_on=True)
    assert client.patch("/channels/999", json={"enabled": False}).status_code == 404
    assert client.delete("/channels/999").status_code == 404


def test_test_channel_endpoint_records_delivery_and_audits(monkeypatch):
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    client, db = _client(monkeypatch, flag_on=True)
    channel_id = client.post("/channels", json=_channel_payload()).json()["id"]
    r = client.post(f"/channels/{channel_id}/test", json={"message": "hello"})
    assert r.status_code == 200
    assert r.json()["success"] is True
    rows = db.query(AuditLog).filter(AuditLog.action == "notification_channel_tested").all()
    assert len(rows) == 1
    assert json.loads(rows[0].details_json)["success"] is True

    deliveries = client.get("/deliveries").json()
    assert deliveries["total"] == 1
    assert deliveries["items"][0]["event_type"] == "test"
    assert deliveries["items"][0]["status"] == "sent"


def test_create_rule_requires_existing_channel(monkeypatch):
    client, _ = _client(monkeypatch, flag_on=True)
    r = client.post("/rules", json={"event_type": "device_offline", "channel_id": 999})
    assert r.status_code == 404


def test_create_update_delete_rule(monkeypatch):
    client, db = _client(monkeypatch, flag_on=True)
    channel_id = client.post("/channels", json=_channel_payload()).json()["id"]

    r = client.post("/rules", json={"event_type": "device_offline", "channel_id": channel_id, "cooldown_seconds": 60})
    assert r.status_code == 200, r.text
    rule = r.json()
    assert rule["event_type"] == "device_offline"
    assert rule["cooldown_seconds"] == 60
    rows = db.query(AuditLog).filter(AuditLog.action == "notification_rule_created").all()
    assert len(rows) == 1

    r = client.patch(f"/rules/{rule['id']}", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    rows = db.query(AuditLog).filter(AuditLog.action == "notification_rule_updated").all()
    assert len(rows) == 1

    r = client.delete(f"/rules/{rule['id']}")
    assert r.status_code == 204
    assert client.get("/rules").json() == []
    rows = db.query(AuditLog).filter(AuditLog.action == "notification_rule_deleted").all()
    assert len(rows) == 1


def test_operator_role_can_read_but_not_write(monkeypatch):
    client, _ = _client(monkeypatch, flag_on=True, role=OperatorRole.OPERATOR.value)
    assert client.get("/channels").status_code == 200
    assert client.post("/channels", json=_channel_payload()).status_code == 403


def test_readonly_role_cannot_read(monkeypatch):
    client, _ = _client(monkeypatch, flag_on=True, role=OperatorRole.READONLY.value)
    assert client.get("/channels").status_code == 403


def test_deliveries_filterable_by_status(monkeypatch):
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (False, "nope"))
    client, _ = _client(monkeypatch, flag_on=True)
    channel_id = client.post("/channels", json=_channel_payload()).json()["id"]
    client.post(f"/channels/{channel_id}/test", json={})
    r = client.get("/deliveries", params={"status": "failed"})
    assert r.json()["total"] == 1
    r = client.get("/deliveries", params={"status": "sent"})
    assert r.json()["total"] == 0
