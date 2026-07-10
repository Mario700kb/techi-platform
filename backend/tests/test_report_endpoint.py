from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import reports as reports_endpoint
from app.core.auth import get_current_operator, get_operator_scope
from app.core.config import settings
from app.core.scope import AllowedScope
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.device import Device
from app.models.operator import OperatorRole


def _client(monkeypatch, tmp_path, *, flag=True, role="admin", scope=None, grant_view=True):
    monkeypatch.setattr(settings, "FEATURE_REPORTING", flag)
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    c1 = Client(name="Client One", slug="one", is_active=True)
    c2 = Client(name="Client Two", slug="two", is_active=True)
    db.add_all([c1, c2])
    db.commit()
    db.refresh(c1); db.refresh(c2)
    db.add_all([Device(hostname="ONE-PC", client_id=c1.id), Device(hostname="TWO-PC", client_id=c2.id)])
    db.commit()
    app = FastAPI()
    app.include_router(reports_endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=role)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.dependency_overrides[get_operator_scope] = lambda: scope
    if grant_view:
        app.dependency_overrides[reports_endpoint._require_view] = lambda: None
    return TestClient(app), db, c1, c2


def test_flag_off_is_dark(monkeypatch, tmp_path):
    client, _, c1, _ = _client(monkeypatch, tmp_path, flag=False)
    assert client.get("/clients").status_code == 404
    assert client.post("/generate", json={"client_id": c1.id, "report_format": "pdf"}).status_code == 404


def test_generate_list_download_and_audit(monkeypatch, tmp_path):
    client, db, c1, _ = _client(monkeypatch, tmp_path)
    response = client.post("/generate", json={"client_id": c1.id, "report_format": "pdf", "period_days": 30})
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "completed"
    assert client.get("/runs").json()["total"] == 1
    download = client.get(f"/runs/{run['id']}/download")
    assert download.status_code == 200
    assert download.content.startswith(b"%PDF")
    actions = {row.action for row in db.query(AuditLog).all()}
    assert {"report_generated", "report_downloaded"} <= actions


def test_client_scope_prevents_cross_client_export(monkeypatch, tmp_path):
    scope = AllowedScope(client_ids=frozenset({1}))
    client, _, c1, c2 = _client(monkeypatch, tmp_path, role=OperatorRole.OPERATOR.value, scope=scope)
    assert client.get("/clients").json() == [{"id": c1.id, "name": c1.name}]
    assert client.post("/generate", json={"client_id": c1.id, "report_format": "csv"}).status_code == 200
    assert client.post("/generate", json={"client_id": c2.id, "report_format": "csv"}).status_code == 404


def test_group_only_scope_cannot_escalate_to_full_client_report(monkeypatch, tmp_path):
    scope = AllowedScope(group_ids=frozenset({99}))
    client, _, c1, _ = _client(monkeypatch, tmp_path, role=OperatorRole.OPERATOR.value, scope=scope)
    assert client.post("/generate", json={"client_id": c1.id, "report_format": "pdf"}).status_code == 404


def test_view_permission_is_required(monkeypatch, tmp_path):
    client, _, c1, _ = _client(
        monkeypatch, tmp_path, role=OperatorRole.OPERATOR.value,
        scope=AllowedScope(client_ids=frozenset({1})), grant_view=False,
    )
    assert client.get("/clients").status_code == 403
    assert client.post("/generate", json={"client_id": c1.id, "report_format": "pdf"}).status_code == 403


def test_schedule_crud_admin_and_validation(monkeypatch, tmp_path):
    client, db, c1, _ = _client(monkeypatch, tmp_path)
    payload = {
        "name": "Monthly proof", "client_id": c1.id, "report_format": "pdf", "cadence": "monthly",
        "period_days": 30, "hour_utc": 6, "day_of_month": 1,
    }
    created = client.post("/schedules", json=payload)
    assert created.status_code == 200, created.text
    schedule_id = created.json()["id"]
    assert client.get("/schedules").json()[0]["client_name"] == c1.name
    assert client.patch(f"/schedules/{schedule_id}", json={"enabled": False}).json()["enabled"] is False
    assert client.delete(f"/schedules/{schedule_id}").status_code == 204
    actions = {row.action for row in db.query(AuditLog).all()}
    assert {"report_schedule_created", "report_schedule_updated", "report_schedule_deleted"} <= actions


def test_operator_cannot_manage_schedules(monkeypatch, tmp_path):
    client, _, c1, _ = _client(monkeypatch, tmp_path, role=OperatorRole.OPERATOR.value, scope=AllowedScope(client_ids=frozenset({1})))
    assert client.get("/schedules").status_code == 403
    assert client.post("/schedules", json={
        "name": "x", "client_id": c1.id, "cadence": "daily", "hour_utc": 1,
    }).status_code == 403
