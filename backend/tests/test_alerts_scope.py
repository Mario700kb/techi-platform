"""Alerts are scoped to the operator's clients, like the devices they belong to.

The alert list, the alert counts and manual resolve ignored the operator's
scope: a technician limited to one client saw every client's alerts (with
hostnames), counted them in the bell badge, and could resolve any alert by id.
The per-device alert endpoint was already scoped; these were not.
"""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import alerts as alerts_endpoint
from app.core.auth import get_current_operator, get_operator_scope
from app.core.scope import AllowedScope
from app.db.base import Base
from app.db.session import get_db
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device

TOKEN_ALERT = {
    "id": -1, "device_id": None, "token_id": 9, "kind": "token_usage_warning", "severity": "warning",
    "state": "open", "message": "Token almost used up", "detail": None,
    "created_at": "2026-10-11T10:00:00", "updated_at": "2026-10-11T10:00:00",
}


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture()
def fleet(db):
    acme = Client(name="Acme", slug="acme")
    globex = Client(name="Globex", slug="globex")
    db.add_all([acme, globex])
    db.flush()
    pc = Device(hostname="DESKTOP-UKPKR96", display_name="K.Xhaferri-PC", rustdesk_id="1", client_id=acme.id)
    srv = Device(hostname="srv-globex", rustdesk_id="2", client_id=globex.id)
    db.add_all([pc, srv])
    db.flush()
    acme_alert = DeviceAlert(device_id=pc.id, kind=AlertKind.DEVICE_OFFLINE, severity=AlertSeverity.CRITICAL,
                             state=AlertState.OPEN, message="DESKTOP-UKPKR96 went offline")
    globex_alert = DeviceAlert(device_id=srv.id, kind=AlertKind.HIGH_CPU, severity=AlertSeverity.WARNING,
                               state=AlertState.OPEN, message="CPU elevated on srv-globex: 80%")
    db.add_all([acme_alert, globex_alert])
    db.commit()
    return SimpleNamespace(acme=acme, globex=globex, acme_alert=acme_alert, globex_alert=globex_alert)


def _client(db, monkeypatch, scope):
    monkeypatch.setattr(alerts_endpoint, "build_token_usage_alerts", lambda _db: [dict(TOKEN_ALERT)])
    app = FastAPI()
    app.include_router(alerts_endpoint.router, prefix="/api/v1/alerts")
    operator = SimpleNamespace(id=1, role="operator", username="tech")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.dependency_overrides[get_operator_scope] = lambda: scope
    return TestClient(app)


def test_a_scoped_operator_lists_only_their_clients_alerts(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, AllowedScope(client_ids=frozenset({fleet.acme.id})))

    listed = client.get("/api/v1/alerts/", params={"state": "open"}).json()

    assert [a["id"] for a in listed] == [fleet.acme_alert.id]


def test_a_scoped_operator_counts_only_their_clients_alerts(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, AllowedScope(client_ids=frozenset({fleet.acme.id})))

    counts = client.get("/api/v1/alerts/count").json()

    assert counts["total_open"] == 1
    assert counts["by_severity"] == {"critical": 1}
    assert counts["by_kind"] == {"device_offline": 1}


def test_out_of_scope_alerts_cannot_be_resolved_and_look_missing(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, AllowedScope(client_ids=frozenset({fleet.acme.id})))

    assert client.put(f"/api/v1/alerts/{fleet.globex_alert.id}/resolve").status_code == 404
    db.refresh(fleet.globex_alert)
    assert fleet.globex_alert.state == AlertState.OPEN
    assert client.put(f"/api/v1/alerts/{fleet.acme_alert.id}/resolve").status_code == 200


def test_unscoped_operator_sees_everything_including_token_alerts(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, None)

    listed = client.get("/api/v1/alerts/", params={"state": "open"}).json()
    counts = client.get("/api/v1/alerts/count").json()

    assert {a["id"] for a in listed} == {-1, fleet.acme_alert.id, fleet.globex_alert.id}
    assert counts["total_open"] == 3
    assert counts["by_kind"]["token_usage_warning"] == 1


def test_token_alerts_are_hidden_from_scoped_operators(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, AllowedScope(client_ids=frozenset({fleet.globex.id})))

    listed = client.get("/api/v1/alerts/", params={"state": "open"}).json()

    assert [a["id"] for a in listed] == [fleet.globex_alert.id]


def test_alerts_carry_the_current_device_name_and_client(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, None)

    listed = {a["id"]: a for a in client.get("/api/v1/alerts/", params={"state": "open"}).json()}

    assert listed[fleet.acme_alert.id]["device_name"] == "K.Xhaferri-PC"
    assert listed[fleet.acme_alert.id]["client_name"] == "Acme"
    assert listed[fleet.globex_alert.id]["device_name"] == "srv-globex"


def test_severity_and_kind_filters(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, None)

    critical = client.get("/api/v1/alerts/", params={"state": "open", "severity": "critical"}).json()
    cpu = client.get("/api/v1/alerts/", params={"state": "open", "kind": "high_cpu"}).json()

    assert [a["id"] for a in critical] == [fleet.acme_alert.id]
    assert [a["id"] for a in cpu] == [fleet.globex_alert.id]


def test_search_filters_the_list_and_its_counts_on_the_server(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, None)

    listed = client.get("/api/v1/alerts/", params={"state": "open", "search": "xhaferri"}).json()
    by_client = client.get("/api/v1/alerts/", params={"state": "open", "search": "globex"}).json()
    counts = client.get("/api/v1/alerts/count", params={"search": "xhaferri"}).json()

    assert [a["id"] for a in listed] == [fleet.acme_alert.id]
    assert [a["id"] for a in by_client] == [fleet.globex_alert.id]
    assert counts["total_open"] == 1
    assert counts["devices_affected"] == 1


def test_counts_report_devices_affected_and_the_oldest_open_alert(db, fleet, monkeypatch):
    client = _client(db, monkeypatch, AllowedScope(client_ids=frozenset({fleet.acme.id, fleet.globex.id})))

    counts = client.get("/api/v1/alerts/count").json()

    assert counts["devices_affected"] == 2
    assert counts["oldest_open_at"] is not None
