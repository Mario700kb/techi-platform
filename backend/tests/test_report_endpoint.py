from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
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


def _client_reusing_db(db, *, role="admin", scope=None, grant_view=True) -> TestClient:
    app = FastAPI()
    app.include_router(reports_endpoint.router)
    operator = SimpleNamespace(id=1, username="mario", role=role)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.dependency_overrides[get_operator_scope] = lambda: scope
    if grant_view:
        app.dependency_overrides[reports_endpoint._require_view] = lambda: None
    return TestClient(app)


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
    assert client.get(f"/runs/{run['id']}/download").content == download.content
    assert client.get("/runs").json()["items"][0]["filename"] == run["filename"]
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
        "period_days": 30, "hour_local": 6, "day_of_month": 1,
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
        "name": "x", "client_id": c1.id, "cadence": "daily", "hour_local": 1,
    }).status_code == 403


def test_delete_run_removes_file_and_row_but_not_its_schedule(monkeypatch, tmp_path):
    client, db, c1, _ = _client(monkeypatch, tmp_path)
    schedule = client.post("/schedules", json={
        "name": "Monthly proof", "client_id": c1.id, "report_format": "pdf", "cadence": "monthly",
        "period_days": 30, "hour_local": 6, "day_of_month": 1,
    }).json()
    generated = client.post("/generate", json={"client_id": c1.id, "report_format": "pdf", "period_days": 30}).json()
    run_id = generated["id"]

    storage_path = db.execute(
        text("SELECT storage_path FROM report_runs WHERE id = :id"), {"id": run_id}
    ).scalar()
    assert Path(storage_path).is_file()

    response = client.delete(f"/runs/{run_id}")
    assert response.status_code == 204
    assert not Path(storage_path).exists()
    assert client.get("/runs").json()["total"] == 0

    # deleting the run must never touch its parent schedule
    assert client.get("/schedules").json()[0]["id"] == schedule["id"]
    actions = {row.action for row in db.query(AuditLog).all()}
    assert "report_run_deleted" in actions


def test_delete_run_tolerates_already_missing_file(monkeypatch, tmp_path):
    client, db, c1, _ = _client(monkeypatch, tmp_path)
    generated = client.post("/generate", json={"client_id": c1.id, "report_format": "csv", "period_days": 30}).json()
    run_id = generated["id"]
    storage_path = db.execute(
        text("SELECT storage_path FROM report_runs WHERE id = :id"), {"id": run_id}
    ).scalar()
    Path(storage_path).unlink()  # simulate the file already being gone

    response = client.delete(f"/runs/{run_id}")
    assert response.status_code == 204
    assert client.get("/runs").json()["total"] == 0


def test_delete_run_requires_admin(monkeypatch, tmp_path):
    client, db, c1, _ = _client(monkeypatch, tmp_path)
    generated = client.post("/generate", json={"client_id": c1.id, "report_format": "pdf", "period_days": 30}).json()
    operator_client = _client_reusing_db(
        db, role=OperatorRole.OPERATOR.value, scope=AllowedScope(client_ids=frozenset({1})),
    )
    assert operator_client.delete(f"/runs/{generated['id']}").status_code == 403
    # still present — denied attempt must not have deleted it
    assert client.get("/runs").json()["total"] == 1


def test_delete_run_respects_client_scope(monkeypatch, tmp_path):
    admin_client, db, c1, c2 = _client(monkeypatch, tmp_path)
    generated = admin_client.post("/generate", json={"client_id": c2.id, "report_format": "pdf", "period_days": 30}).json()
    # admin role (passes the _require_admin gate) but scoped to client one only —
    # exercises _ensure_client_scope in isolation from the role check.
    scoped_client = _client_reusing_db(db, scope=AllowedScope(client_ids=frozenset({1})))
    # can't even see client two's report, so no leak — same not-found contract as generate/download
    assert scoped_client.delete(f"/runs/{generated['id']}").status_code == 404
    assert admin_client.get("/runs").json()["total"] == 1


def test_delete_run_missing_returns_404(monkeypatch, tmp_path):
    client, _, _, _ = _client(monkeypatch, tmp_path)
    assert client.delete("/runs/999999").status_code == 404


def test_device_generate_history_download_obey_device_scope(monkeypatch, tmp_path):
    admin, db, c1, _ = _client(monkeypatch, tmp_path)
    first = db.query(Device).filter(Device.client_id == c1.id).first()
    second = Device(hostname="SECOND", client_id=c1.id)
    db.add(second)
    db.commit()
    db.refresh(second)
    payload = {"scope_type": "device", "device_id": first.id, "report_type": "full", "report_format": "pdf", "period_days": 30}
    created = admin.post("/generate", json=payload)
    assert created.status_code == 200, created.text
    run = created.json()
    assert run["device_id"] == first.id
    assert run["report_type"] == "full"
    assert admin.get(f"/runs/{run['id']}/download").status_code == 200

    scoped = _client_reusing_db(db, role="operator", scope=AllowedScope(device_ids=frozenset({second.id})))
    assert scoped.post("/generate", json=payload).status_code == 404
    assert scoped.get("/runs").json()["total"] == 0
    assert scoped.get(f"/runs/{run['id']}/download").status_code == 404
    assert scoped.delete(f"/runs/{run['id']}").status_code == 403

    allowed = _client_reusing_db(db, role="operator", scope=AllowedScope(device_ids=frozenset({first.id})))
    assert allowed.get("/runs").json()["total"] == 1
    assert allowed.get(f"/runs/{run['id']}/download").status_code == 200
    assert allowed.post("/generate", json={**payload, "report_type": "full", "report_format": "csv"}).status_code == 422
    assert allowed.post("/generate", json={**payload, "device_id": 999999}).status_code == 404
    assert allowed.post("/generate", json={**payload, "period_from": "2026-09-01T00:00:00Z"}).status_code == 422

    logs = db.query(AuditLog).filter(AuditLog.action == "report_generated").all()
    assert any('"device_id":' in (log.details_json or "") for log in logs)


def test_device_custom_range_and_legacy_client_row(monkeypatch, tmp_path):
    client, db, c1, _ = _client(monkeypatch, tmp_path)
    device = db.query(Device).filter(Device.client_id == c1.id).first()
    response = client.post("/generate", json={
        "scope_type": "device", "device_id": device.id, "report_type": "alerts",
        "report_format": "csv", "period_from": "2026-09-01T00:00:00Z",
        "period_to": "2026-09-02T00:00:00Z",
    })
    assert response.status_code == 200, response.text
    assert response.json()["period_start"].startswith("2026-09-01")
    legacy = client.post("/generate", json={"client_id": c1.id, "report_format": "pdf"})
    assert legacy.status_code == 200, legacy.text
    assert legacy.json()["scope_type"] == "client"
    assert legacy.json()["report_type"] == "full"
    assert client.get("/runs").json()["total"] == 2


def test_group_only_scope_can_report_its_device_without_client_export(monkeypatch, tmp_path):
    client, db, c1, _ = _client(monkeypatch, tmp_path)
    device = db.query(Device).filter(Device.client_id == c1.id).first()
    device.group_id = 42
    db.commit()
    group_client = _client_reusing_db(db, role="operator", scope=AllowedScope(group_ids=frozenset({42})))
    payload = {"scope_type": "device", "device_id": device.id, "report_type": "overview", "report_format": "csv"}
    response = group_client.post("/generate", json=payload)
    assert response.status_code == 200, response.text
    assert group_client.get("/runs").json()["total"] == 1
    assert group_client.get(f"/runs/{response.json()['id']}/download").status_code == 200
    assert group_client.post("/generate", json={"client_id": c1.id}).status_code == 404


def test_device_move_does_not_expose_old_report_to_new_group(monkeypatch, tmp_path):
    admin, db, c1, _ = _client(monkeypatch, tmp_path)
    device = db.query(Device).filter(Device.client_id == c1.id).first()
    device.group_id = 10
    db.commit()
    generated = admin.post("/generate", json={
        "scope_type": "device", "device_id": device.id,
        "report_type": "overview", "report_format": "pdf",
    })
    assert generated.status_code == 200, generated.text
    run_id = generated.json()["id"]
    device.group_id = 11
    db.commit()
    new_group = _client_reusing_db(db, role="operator", scope=AllowedScope(group_ids=frozenset({11})))
    assert new_group.get("/runs").json()["total"] == 0
    assert new_group.get(f"/runs/{run_id}/download").status_code == 404
    assert admin.get(f"/runs/{run_id}/download").status_code == 200
