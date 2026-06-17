"""
Tests verifying that GET /api/v1/devices/ returns only scope-filtered devices.

Confirms that:
- Operator in Team A (client_ids=[1]) sees only client_id=1 devices.
- Out-of-scope devices (client_id=2) are NOT returned.
- rustdesk_id from out-of-scope devices is NOT present in the response.
- Admin/Owner bypass scope and see all devices.
- Operator in no team sees no devices (empty scope).
- Count endpoint is also scope-filtered.
"""

import json
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.device_inventory import DeviceInventory
from app.models.device_telemetry import DeviceTelemetry
from app.models.alert import DeviceAlert
from app.models.operator import Operator
from app.models.team import Team, TeamMember, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess
from app.core.auth import get_current_operator
from app.core.time import utcnow
from app.api.v1.endpoints import devices as devices_module
from app.services import device_service as device_service_module
from app.services.device_overview_service import DeviceOverviewService, _overview_cache
from app.services.device_summary_service import DeviceSummaryService

# ── Tables needed ─────────────────────────────────────────────────────────── #
# Client and DeviceGroup tables are required because DeviceAssignmentService
# lazy-loads device.client and device.group when building response objects.

TABLES = [
    Client.__table__,
    DeviceGroup.__table__,
    Device.__table__,
    DeviceTelemetry.__table__,
    DeviceInventory.__table__,
    DeviceAlert.__table__,
    Operator.__table__,
    Team.__table__,
    TeamMember.__table__,
    TeamClientAccess.__table__,
    TeamDeviceAccess.__table__,
    TeamGroupAccess.__table__,
]


# ── DB fixture ────────────────────────────────────────────────────────────── #

@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine, tables=TABLES)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


# ── Helpers ───────────────────────────────────────────────────────────────── #

def _operator(db, username: str, role: str = "operator") -> Operator:
    op = Operator(
        username=username, email=f"{username}@test.com",
        hashed_password="x", role=role, is_active=True, is_superuser=False,
    )
    db.add(op); db.commit(); db.refresh(op)
    return op


def _device(db, rustdesk_id: str, client_id: int, hostname: str) -> Device:
    d = Device(
        rustdesk_id=rustdesk_id,
        hostname=hostname,
        client_id=client_id,
        status="offline",
        device_type="client",
        rustdesk_install_status="unknown",
        rustdesk_status="unknown",
        rustdesk_sync_state="unknown",
        assignment_source="manual",
    )
    db.add(d); db.commit(); db.refresh(d)
    return d


def _write_agent_manifest(tmp_path, items):
    package_dir = tmp_path / "agent-packages"
    package_dir.mkdir()
    manifest = []
    for item in items:
        manifest.append({
            "id": item["id"],
            "version": item["version"],
            "platform": item["platform"],
            "filename": item.get("filename", "agent.msi"),
            "uploaded_at": item.get("uploaded_at", "2026-06-17T09:00:00+00:00"),
            "uploaded_by": item.get("uploaded_by", "pytest"),
            "is_active": item.get("is_active", True),
            "sha256": item.get("sha256", "abc123"),
        })
    (package_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return package_dir


def _team_with_client(db, operator: Operator, client_id: int) -> Team:
    team = Team(name=f"Team-{client_id}-{operator.id}", color="#f97316")
    db.add(team); db.commit(); db.refresh(team)
    db.add(TeamMember(team_id=team.id, operator_id=operator.id))
    db.add(TeamClientAccess(team_id=team.id, client_id=client_id))
    db.commit()
    return team


def _client_for(db, operator: Operator, device_id: int) -> Team:
    """Grant explicit device-level access to operator."""
    team = Team(name=f"Team-dev-{device_id}-{operator.id}", color="#f97316")
    db.add(team); db.commit(); db.refresh(team)
    db.add(TeamMember(team_id=team.id, operator_id=operator.id))
    db.add(TeamDeviceAccess(team_id=team.id, device_id=device_id))
    db.commit()
    return team


def _make_app(db, operator: Operator) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.include_router(devices_module.router, prefix="/devices")
    return TestClient(app, raise_server_exceptions=False)


def _devices_payload(resp):
    body = resp.json()
    return body["devices"] if isinstance(body, dict) and "devices" in body else body


# ── Tests ─────────────────────────────────────────────────────────────────── #

class TestDeviceScopeByClientId:
    def test_operator_in_team_a_sees_only_team_a_devices(self, db):
        op = _operator(db, "op_scope")
        _team_with_client(db, op, client_id=1)

        dev_in  = _device(db, "RUST-001", client_id=1, hostname="techi-pc")
        dev_out = _device(db, "RUST-999", client_id=2, hostname="metro-pc")

        client = _make_app(db, op)
        resp = client.get("/devices/")
        assert resp.status_code == 200

        ids = {d["rustdesk_id"] for d in _devices_payload(resp)}
        assert "RUST-001" in ids, "In-scope device must be returned"
        assert "RUST-999" not in ids, "Out-of-scope device must NOT be returned"

    def test_out_of_scope_rustdesk_id_never_returned(self, db):
        op = _operator(db, "op_rustdesk")
        _team_with_client(db, op, client_id=1)

        _device(db, "RUST-IN",  client_id=1, hostname="in-scope")
        _device(db, "RUST-OUT", client_id=2, hostname="out-of-scope")

        client = _make_app(db, op)
        resp = client.get("/devices/")
        assert resp.status_code == 200

        body_text = resp.text
        assert "RUST-IN"  in body_text
        assert "RUST-OUT" not in body_text, "Remote Support ID from out-of-scope device must never appear"

    def test_stats_are_scope_filtered_and_grouped_by_freshness(self, db):
        device_service_module._stats_cache.clear()
        op = _operator(db, "op_stats")
        _team_with_client(db, op, client_id=1)

        online = _device(db, "RUST-ONLINE", client_id=1, hostname="online")
        stale = _device(db, "RUST-STALE", client_id=1, hostname="stale")
        offline = _device(db, "RUST-OFFLINE", client_id=1, hostname="offline")
        outside = _device(db, "RUST-OUTSIDE", client_id=2, hostname="outside")

        online.last_seen = utcnow() - timedelta(seconds=30)
        stale.last_seen = utcnow() - timedelta(minutes=10)
        offline.last_seen = utcnow() - timedelta(minutes=30)
        outside.last_seen = utcnow() - timedelta(seconds=30)
        db.commit()

        client = _make_app(db, op)
        resp = client.get("/devices/stats")

        assert resp.status_code == 200
        assert resp.json() == {
            "total": 3,
            "online": 1,
            "stale": 1,
            "offline": 1,
        }

    def test_summary_is_atomic_and_scope_filtered(self, db):
        op = _operator(db, "op_summary")
        _team_with_client(db, op, client_id=1)
        visible = _device(db, "RUST-SUMMARY-IN", client_id=1, hostname="visible")
        _device(db, "RUST-SUMMARY-OUT", client_id=2, hostname="hidden")
        visible.last_seen = utcnow() - timedelta(seconds=30)
        db.commit()

        response = _make_app(db, op).get("/devices/summary")

        assert response.status_code == 200
        body = response.json()
        assert body["stats"] == {"total": 1, "online": 1, "stale": 0, "offline": 0}
        assert [device["rustdesk_id"] for device in body["devices"]] == ["RUST-SUMMARY-IN"]
        assert body["tree_counts"]["total"] == 1
        assert body["tree_counts"]["by_client"] == {"1": 1}
        assert [item["device_id"] for item in body["health"]] == [visible.id]
        assert [item["device_id"] for item in body["patches"]] == [visible.id]

    def test_overview_is_scope_filtered_and_compact(self, db):
        _overview_cache.clear()
        op = _operator(db, "op_overview")
        _team_with_client(db, op, client_id=1)
        visible = _device(db, "RUST-OVERVIEW-IN", client_id=1, hostname="visible")
        _device(db, "RUST-OVERVIEW-OUT", client_id=2, hostname="hidden")
        visible.last_seen = utcnow() - timedelta(seconds=30)
        db.commit()

        response = _make_app(db, op).get("/devices/overview")

        assert response.status_code == 200
        body = response.json()
        assert body["stats"] == {"total": 1, "online": 1, "stale": 0, "offline": 0}
        assert body["tree_counts"] == {
            "total": 1,
            "unassigned": 0,
            "by_client": {"1": 1},
            "by_client_category": {"1": {"clientpc": 1}},
        }
        assert body["critical"] == 0
        assert body["warnings"] == 0
        assert body["average_health"] == 94
        assert body["needs_updates"] == 0
        assert len(response.content) < 5000

    def test_overview_agent_outdated_is_zero_when_versions_match(self, db, tmp_path, monkeypatch):
        _overview_cache.clear()
        from app.core.config import settings

        package_dir = _write_agent_manifest(tmp_path, [
            {"id": "windows-active", "version": "2.4.0", "platform": "windows-amd64"},
        ])
        monkeypatch.setattr(settings, "AGENT_PACKAGE_STORAGE_DIR", str(package_dir))

        first = _device(db, "RUST-AGENT-1", client_id=1, hostname="agent-current-1")
        second = _device(db, "RUST-AGENT-2", client_id=1, hostname="agent-current-2")
        first.agent_version = "2.4.0"
        second.agent_version = "2.4.0"
        db.commit()

        overview = DeviceOverviewService(db).get_overview()

        assert overview.active_agent_version == "2.4.0"
        assert overview.agents_outdated == 0

    def test_overview_agent_outdated_counts_mismatch_and_missing_versions(self, db, tmp_path, monkeypatch):
        _overview_cache.clear()
        from app.core.config import settings

        package_dir = _write_agent_manifest(tmp_path, [
            {"id": "windows-active", "version": "2.4.0", "platform": "windows-amd64"},
        ])
        monkeypatch.setattr(settings, "AGENT_PACKAGE_STORAGE_DIR", str(package_dir))

        current = _device(db, "RUST-AGENT-CURRENT", client_id=1, hostname="agent-current")
        stale = _device(db, "RUST-AGENT-STALE", client_id=1, hostname="agent-stale")
        missing = _device(db, "RUST-AGENT-MISSING", client_id=1, hostname="agent-missing")
        current.agent_version = "2.4.0"
        stale.agent_version = "2.3.9"
        missing.agent_version = None
        db.commit()

        overview = DeviceOverviewService(db).get_overview()

        assert overview.active_agent_version == "2.4.0"
        assert overview.agents_outdated == 2

    def test_overview_active_agent_version_uses_active_windows_amd64_package(self, db, tmp_path, monkeypatch):
        _overview_cache.clear()
        from app.core.config import settings

        package_dir = _write_agent_manifest(tmp_path, [
            {
                "id": "linux-active",
                "version": "9.9.9",
                "platform": "linux-amd64",
                "uploaded_at": "2026-06-17T10:00:00+00:00",
            },
            {
                "id": "windows-inactive",
                "version": "2.3.0",
                "platform": "windows-amd64",
                "is_active": False,
                "uploaded_at": "2026-06-17T11:00:00+00:00",
            },
            {
                "id": "windows-active",
                "version": "2.4.0",
                "platform": "windows-amd64",
                "uploaded_at": "2026-06-17T09:00:00+00:00",
            },
        ])
        monkeypatch.setattr(settings, "AGENT_PACKAGE_STORAGE_DIR", str(package_dir))

        device = _device(db, "RUST-AGENT-WIN", client_id=1, hostname="agent-win")
        device.agent_version = "2.4.0"
        db.commit()

        overview = DeviceOverviewService(db).get_overview()

        assert overview.active_agent_version == "2.4.0"
        assert overview.agents_outdated == 0

    def test_operator_in_no_team_sees_nothing(self, db):
        op = _operator(db, "op_noteam")
        _device(db, "RUST-ANY", client_id=1, hostname="any-pc")

        client = _make_app(db, op)
        resp = client.get("/devices/")
        assert resp.status_code == 200
        assert _devices_payload(resp) == [], "Operator with no teams must see no devices"

    def test_admin_bypass_sees_all(self, db):
        admin = _operator(db, "admin1", role="admin")
        _device(db, "RUST-C1", client_id=1, hostname="client1-pc")
        _device(db, "RUST-C2", client_id=2, hostname="client2-pc")

        client = _make_app(db, admin)
        resp = client.get("/devices/")
        assert resp.status_code == 200

        ids = {d["rustdesk_id"] for d in _devices_payload(resp)}
        assert "RUST-C1" in ids
        assert "RUST-C2" in ids, "Admin must see all devices"

    def test_owner_bypass_sees_all(self, db):
        owner = _operator(db, "owner1", role="owner")
        _device(db, "RUST-O1", client_id=1, hostname="owner-pc1")
        _device(db, "RUST-O2", client_id=2, hostname="owner-pc2")

        client = _make_app(db, owner)
        resp = client.get("/devices/")
        assert resp.status_code == 200

        ids = {d["rustdesk_id"] for d in _devices_payload(resp)}
        assert "RUST-O1" in ids
        assert "RUST-O2" in ids, "Owner must see all devices"


class TestDeviceScopeWithMultipleClients:
    def test_operator_in_two_client_teams_sees_both(self, db):
        op = _operator(db, "op_multi")
        _team_with_client(db, op, client_id=1)
        _team_with_client(db, op, client_id=3)

        dev1 = _device(db, "RUST-T1", client_id=1, hostname="team1-pc")
        dev3 = _device(db, "RUST-T3", client_id=3, hostname="team3-pc")
        dev2 = _device(db, "RUST-T2", client_id=2, hostname="metro-pc")

        client = _make_app(db, op)
        resp = client.get("/devices/")
        assert resp.status_code == 200

        ids = {d["rustdesk_id"] for d in _devices_payload(resp)}
        assert "RUST-T1" in ids
        assert "RUST-T3" in ids
        assert "RUST-T2" not in ids, "Client 2 device must not be visible"


class TestDeviceScopeByDeviceId:
    def test_explicit_device_access_grants_only_that_device(self, db):
        op = _operator(db, "op_dev")
        dev_ok  = _device(db, "RUST-EXPLICIT", client_id=2, hostname="explicit")
        dev_bad = _device(db, "RUST-OTHER",    client_id=2, hostname="other-metro")
        _client_for(db, op, device_id=dev_ok.id)

        client = _make_app(db, op)
        resp = client.get("/devices/")
        assert resp.status_code == 200

        ids = {d["rustdesk_id"] for d in _devices_payload(resp)}
        assert "RUST-EXPLICIT" in ids
        assert "RUST-OTHER" not in ids, "Only explicitly scoped device must appear"


class TestDeviceCountScope:
    def test_count_respects_scope(self, db):
        op = _operator(db, "op_count")
        _team_with_client(db, op, client_id=1)

        _device(db, "RUST-CNT1", client_id=1, hostname="cnt1")
        _device(db, "RUST-CNT2", client_id=1, hostname="cnt2")
        _device(db, "RUST-CNTX", client_id=2, hostname="cntx")

        client = _make_app(db, op)
        resp = client.get("/devices/count")
        assert resp.status_code == 200
        assert resp.json()["count"] == 2, "Count must only include scoped devices"

    def test_count_zero_for_no_team(self, db):
        op = _operator(db, "op_count_zero")
        _device(db, "RUST-ZERO1", client_id=1, hostname="z1")
        _device(db, "RUST-ZERO2", client_id=2, hostname="z2")

        client = _make_app(db, op)
        resp = client.get("/devices/count")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0


class TestLifecycleAllWithScope:
    def test_lifecycle_all_still_applies_scope(self, db):
        """lifecycle_state=all must not bypass scope filtering."""
        op = _operator(db, "op_lifecycle")
        _team_with_client(db, op, client_id=1)

        dev_in  = _device(db, "RUST-LIVE",  client_id=1, hostname="live")
        dev_out = _device(db, "RUST-METRO", client_id=2, hostname="metro")

        client = _make_app(db, op)
        resp = client.get("/devices/?lifecycle_state=all")
        assert resp.status_code == 200

        ids = {d["rustdesk_id"] for d in _devices_payload(resp)}
        assert "RUST-LIVE"  in ids
        assert "RUST-METRO" not in ids, "lifecycle_state=all must not bypass scope"


def test_summary_uses_bounded_queries_for_700_devices(db):
    db.add_all([
        Device(
            rustdesk_id=f"PERF-{index:04d}",
            hostname=f"device-{index:04d}",
            status="offline",
            device_type="client",
        )
        for index in range(700)
    ])
    db.commit()
    statements = 0

    def count_statement(*_args):
        nonlocal statements
        statements += 1

    event.listen(db.get_bind(), "before_cursor_execute", count_statement)
    try:
        summary = DeviceSummaryService(db).get_summary()
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", count_statement)

    assert summary.stats.total == 700
    assert len(summary.devices) == 700
    assert statements <= 4


def test_overview_uses_two_queries_and_cache(db):
    _overview_cache.clear()
    db.add_all([
        Device(
            rustdesk_id=f"OVERVIEW-{index:04d}",
            hostname=f"device-{index:04d}",
            status="offline",
            device_type="client",
            rustdesk_install_status="unknown",
            rustdesk_status="unknown",
            rustdesk_sync_state="unknown",
            assignment_source="manual",
        )
        for index in range(700)
    ])
    db.commit()
    statements = 0

    def count_statement(*_args):
        nonlocal statements
        statements += 1

    event.listen(db.get_bind(), "before_cursor_execute", count_statement)
    try:
        service = DeviceOverviewService(db)
        overview = service.get_overview()
        cached = service.get_overview()
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", count_statement)

    assert overview.stats.total == 700
    assert overview.tree_counts.by_client_category == {}
    assert cached == overview
    assert statements == 2
