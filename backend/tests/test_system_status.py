"""System status panel: real values, honest unknowns, owner/admin only."""
import json
import os
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import system as system_endpoint
from app.core import worker_health
from app.core.auth import get_current_operator
from app.core.config import settings
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus
from app.services import system_status_service as svc


@pytest.fixture(autouse=True)
def _clean_workers():
    worker_health.reset_for_tests()
    worker_health.cleanup_finished()
    yield
    worker_health.reset_for_tests()


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
    session.execute(text("INSERT INTO alembic_version VALUES (:v)"), {"v": svc._code_head()})
    session.commit()
    return session


def _tiles(db):
    return {t.key: t for t in svc.system_status(db).services}


def _client(db, role):
    app = FastAPI()
    app.include_router(system_endpoint.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=1, username="x", role=role)
    return TestClient(app)


@pytest.mark.parametrize("role,code", [("owner", 200), ("admin", 200), ("operator", 403), ("readonly", 403)])
def test_only_owner_and_admin_see_it(db, role, code):
    assert _client(db, role).get("/status").status_code == code


def test_database_live_when_schema_matches(db):
    tile = _tiles(db)["database"]
    assert tile.state == "ok"
    assert svc._code_head() in tile.detail


def test_database_warns_when_migration_pending(db):
    db.execute(text("UPDATE alembic_version SET version_num = 'old'"))
    db.commit()
    tile = _tiles(db)["database"]
    assert tile.state == "warn"
    assert "migration pending" in tile.sub


def test_agents_live_and_stalled(db):
    now = utcnow().replace(tzinfo=None)
    db.add_all([
        Device(hostname="a", status=DeviceStatus.ONLINE, last_seen=now - timedelta(seconds=20), is_archived=False),
        Device(hostname="b", status=DeviceStatus.ONLINE, last_seen=now - timedelta(minutes=10), is_archived=False),
    ])
    db.commit()
    tile = _tiles(db)["agents"]
    assert (tile.state, tile.value, tile.total) == ("ok", 1, 2)

    db.query(Device).update({Device.last_seen: now - timedelta(minutes=4)})
    db.commit()
    assert _tiles(db)["agents"].state == "down"  # newest heartbeat > 2 min with devices online


def test_agent_versions_synced_threshold(db, monkeypatch):
    monkeypatch.setattr(svc.version_service, "get_active_version", lambda platform: "2.1.20")
    db.add_all([Device(hostname=f"d{i}", agent_version="2.1.20", platform="windows", is_archived=False) for i in range(9)])
    db.add(Device(hostname="old", agent_version="2.0.0", platform="windows", is_archived=False))
    db.commit()
    tile = _tiles(db)["agent_versions"]
    assert (tile.state, tile.label, tile.detail) == ("done", "Synced", "9 / 10 on 2.1.20")

    db.add_all([Device(hostname=f"o{i}", agent_version="2.0.0", platform="windows", is_archived=False) for i in range(3)])
    db.commit()
    assert _tiles(db)["agent_versions"].state == "warn"


def test_workers_running_and_stopped(db):
    alive = {"ok": True}
    worker_health.register("reconcile", "reconcile", 30, lambda: alive["ok"])
    worker_health.beat("reconcile")
    tile = _tiles(db)["workers"]
    assert (tile.state, tile.label) == ("ok", "1 / 1")

    alive["ok"] = False
    tile = _tiles(db)["workers"]
    assert (tile.state, tile.label) == ("down", "0 / 1")
    assert "reconcile stopped" in tile.detail


def test_worker_overdue_when_it_stops_beating(db):
    worker_health.register("reports", "reports", 60, lambda: True)
    worker_health.beat("reports")
    later = utcnow() + timedelta(minutes=10)
    assert worker_health.snapshot(later)[0]["state"] == "down"


def test_cleanup_unknown_running_done(db):
    assert _tiles(db)["cleanup"].state == "unknown"

    worker_health.cleanup_started()
    assert _tiles(db)["cleanup"].state == "running"
    worker_health.cleanup_finished()

    db.add(AuditLog(operator_username="system", action="nightly_cleanup",
                    details_json=json.dumps({"rows_deleted": 41208, "failed_tasks": [], "duration_seconds": 1.8}),
                    created_at=utcnow().replace(tzinfo=None)))
    db.commit()
    tile = _tiles(db)["cleanup"]
    assert (tile.state, tile.detail) == ("done", "41,208 rows removed · 1.8 s")


def test_backup_states(db, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "BACKUP_DIR", str(tmp_path / "missing"))
    assert _tiles(db)["backup"].state == "unknown"

    monkeypatch.setattr(settings, "BACKUP_DIR", str(tmp_path))
    assert _tiles(db)["backup"].state == "down"

    dump = tmp_path / "postgres-2026-10-05_03-00.sql.gz"
    dump.write_bytes(b"x" * 2_000_000)
    (tmp_path / "pre-tirana-global-2026-10-05_15-02.sql.gz").write_bytes(b"manual dumps are not the nightly one")
    tile = _tiles(db)["backup"]
    assert (tile.state, tile.detail) == ("done", "2 MB · verified")

    old = (utcnow() - timedelta(hours=30)).timestamp()
    os.utime(dump, (old, old))
    assert _tiles(db)["backup"].state == "warn"
