"""Client profile: /clients/{id}/profile and /activity, and client_id on alerts
and insights — all limited to the part of the client the operator can see."""
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints import alerts as alerts_module
from app.api.v1.endpoints import clients as clients_module
from app.api.v1.endpoints import devices as devices_module
from app.core.auth import get_current_operator
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.alert import DeviceAlert
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.device import Device
from app.models.client_location import ClientLocation, ClientLocationRule
from app.models.device_group import DeviceGroup
from app.models.device_inventory import DeviceInventory
from app.models.device_telemetry import DeviceTelemetry
from app.models.operator import Operator
from app.models.team import Team, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember
from app.repositories.audit_log_repository import AuditLogRepository
from app.services.device_overview_service import invalidate_overview_cache

TABLES = [
    Client.__table__,
    DeviceGroup.__table__,
    ClientLocation.__table__, ClientLocationRule.__table__, Device.__table__,
    DeviceTelemetry.__table__,
    DeviceInventory.__table__,
    DeviceAlert.__table__,
    AuditLog.__table__,
    Operator.__table__,
    Team.__table__,
    TeamMember.__table__,
    TeamClientAccess.__table__,
    TeamDeviceAccess.__table__,
    TeamGroupAccess.__table__,
]


@pytest.fixture()
def db():
    invalidate_overview_cache()
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine, tables=TABLES)
    session = sessionmaker(bind=engine)()
    session.add_all([
        Client(id=1, name="Northwind", slug="northwind", is_active=True),
        Client(id=2, name="Blue Harbor", slug="blue-harbor", is_active=True),
        DeviceGroup(id=10, client_id=1, name="Front desk"),
        DeviceGroup(id=11, client_id=1, name="Servers"),
        DeviceGroup(id=20, client_id=2, name="Warehouse"),
    ])
    session.commit()
    _device(session, 101, client_id=1, group_id=10, online=True)
    _device(session, 102, client_id=1, group_id=10, online=False)
    _device(session, 103, client_id=1, group_id=11, online=True, device_type="server")
    _device(session, 201, client_id=2, group_id=20, online=True)
    _alert(session, 102, "device_offline", "critical")
    _alert(session, 103, "low_disk", "warning")
    _alert(session, 201, "high_cpu", "warning")
    yield session
    session.close()
    invalidate_overview_cache()


def _device(db, device_id, *, client_id, group_id, online, device_type="client"):
    db.add(Device(
        id=device_id, rustdesk_id=f"RD-{device_id}", hostname=f"host-{device_id}", client_id=client_id,
        group_id=group_id, device_type=device_type, status="online" if online else "offline",
        last_seen=utcnow() - (timedelta(seconds=20) if online else timedelta(days=2)),
        rustdesk_install_status="unknown", rustdesk_status="unknown", rustdesk_sync_state="unknown",
        assignment_source="manual",
    ))
    db.commit()


def _alert(db, device_id, kind, severity):
    db.add(DeviceAlert(device_id=device_id, kind=kind, severity=severity, state="open", message=kind))
    db.commit()


def _operator(db, username, role="operator"):
    op = Operator(username=username, email=f"{username}@test.com", hashed_password="x", role=role,
                  is_active=True, is_superuser=False)
    db.add(op)
    db.commit()
    db.refresh(op)
    return op


def _team(db, op, *, client_id=None, device_id=None):
    team = Team(name=f"team-{op.username}", color="#f97316")
    db.add(team)
    db.commit()
    db.add(TeamMember(team_id=team.id, operator_id=op.id))
    if client_id:
        db.add(TeamClientAccess(team_id=team.id, client_id=client_id))
    if device_id:
        db.add(TeamDeviceAccess(team_id=team.id, device_id=device_id))
    db.commit()


def _api(db, op):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: op
    app.include_router(clients_module.router, prefix="/clients")
    app.include_router(alerts_module.router, prefix="/alerts")
    app.include_router(devices_module.router, prefix="/devices")
    return TestClient(app, raise_server_exceptions=True)


def test_profile_counts_only_this_clients_devices_and_alerts(db):
    body = _api(db, _operator(db, "boss", role="admin")).get("/clients/1/profile").json()

    assert body["client"]["name"] == "Northwind"
    assert body["stats"]["total"] == 3
    assert body["alerts"]["total_open"] == 2
    assert body["alerts"]["by_kind"] == {"device_offline": 1, "low_disk": 1}
    assert body["groups"] == [
        {"id": 10, "name": "Front desk", "devices": 2},
        {"id": 11, "name": "Servers", "devices": 1},
    ]
    assert body["last_seen"] is not None


def test_a_client_outside_the_operators_teams_is_not_found(db):
    op = _operator(db, "outsider")
    _team(db, op, client_id=2)
    api = _api(db, op)

    assert api.get("/clients/1/profile").status_code == 404
    assert api.get("/clients/1/activity").status_code == 404
    assert api.get("/alerts/", params={"client_id": 1}).status_code == 404
    assert api.get("/alerts/count", params={"client_id": 1}).status_code == 404
    assert api.get("/devices/insights", params={"client_id": 1}).status_code == 404
    assert api.get("/clients/999/profile").status_code == 404


def test_an_operator_with_one_device_sees_only_that_part_of_the_client(db):
    op = _operator(db, "partial")
    _team(db, op, device_id=102)
    api = _api(db, op)

    profile = api.get("/clients/1/profile").json()
    assert profile["stats"]["total"] == 1
    assert profile["alerts"]["by_kind"] == {"device_offline": 1}
    assert profile["groups"] == [{"id": 10, "name": "Front desk", "devices": 1}]

    alerts = api.get("/alerts/", params={"client_id": 1, "state": "open"}).json()
    assert [a["device_id"] for a in alerts] == [102]


def test_alerts_filter_by_client(db):
    api = _api(db, _operator(db, "boss", role="admin"))

    alerts = api.get("/alerts/", params={"client_id": 1, "state": "open"}).json()
    assert sorted(a["device_id"] for a in alerts) == [102, 103]
    count = api.get("/alerts/count", params={"client_id": 2}).json()
    assert count["total_open"] == 1 and count["by_kind"] == {"high_cpu": 1}


def test_audit_entries_resolve_their_device_and_client_when_written(db):
    repo = AuditLogRepository(db)
    by_entity = repo.create(operator_id=1, operator_username="mario", action="remote_connect",
                            entity_type="device", entity_id=101)
    by_details = repo.create(operator_id=1, operator_username="mario", action="terminal_session_closed",
                             entity_type="terminal_session", details={"device_id": 103, "session_id": "x"})
    unrelated = repo.create(operator_id=1, operator_username="mario", action="team_updated", entity_type="team",
                            entity_id=5)

    assert (by_entity.device_id, by_entity.client_id) == (101, 1)
    assert (by_details.device_id, by_details.client_id) == (103, 1)
    assert (unrelated.device_id, unrelated.client_id) == (None, None)


def test_activity_lists_the_clients_entries_within_the_operators_view(db):
    repo = AuditLogRepository(db)
    for device_id in (101, 102, 201):
        repo.create(operator_id=1, operator_username="mario", action="remote_connect", entity_type="device",
                    entity_id=device_id)

    full = _api(db, _operator(db, "boss", role="admin")).get("/clients/1/activity").json()
    assert full["total"] == 2
    assert sorted(item["entity_id"] for item in full["items"]) == [101, 102]
    assert full["device_names"] == {"101": "host-101", "102": "host-102"}

    op = _operator(db, "partial")
    _team(db, op, device_id=102)
    partial = _api(db, op).get("/clients/1/activity").json()
    assert [item["entity_id"] for item in partial["items"]] == [102]


def test_resolved_alerts_list_newest_resolution_first(db):
    for device_id, hours in ((101, 5), (102, 1)):
        db.add(DeviceAlert(device_id=device_id, kind="high_cpu", severity="warning", state="resolved",
                           message="cpu", resolved_at=utcnow() - timedelta(hours=hours)))
    db.commit()
    api = _api(db, _operator(db, "boss", role="admin"))

    resolved = api.get("/alerts/", params={"client_id": 1, "state": "resolved"}).json()
    assert [a["device_id"] for a in resolved] == [102, 101]
    assert all(a["state"] == "resolved" for a in resolved)
    unscoped = api.get("/alerts/", params={"state": "resolved"}).json()
    assert all(a["state"] == "resolved" for a in unscoped)


def test_activity_filters_by_kind_and_operator(db):
    repo = AuditLogRepository(db)
    repo.create(operator_id=1, operator_username="mario", action="remote_connect", entity_type="device",
                entity_id=101)
    repo.create(operator_id=2, operator_username="denis", action="remote_connect", entity_type="device",
                entity_id=102)
    repo.create(operator_id=1, operator_username="mario", action="terminal_session_closed",
                entity_type="terminal_session", details={"device_id": 103, "session_id": "s1",
                                                         "duration_seconds": 90})
    repo.create(operator_id=1, operator_username="mario", action="action_queued", entity_type="remote_action",
                details={"device_id": 101, "action_type": "restart_device"})
    api = _api(db, _operator(db, "boss", role="admin"))

    def actions(**params):
        return sorted(item["action"] for item in api.get("/clients/1/activity", params=params).json()["items"])

    assert actions(kind="remote") == ["remote_connect", "remote_connect"]
    assert actions(kind="terminal") == ["terminal_session_closed"]
    assert actions(kind="actions") == ["action_queued"]
    assert actions(kind="remote", operator="denis") == ["remote_connect"]
    assert len(actions()) == 4
    assert api.get("/clients/1/activity", params={"kind": "nope"}).status_code == 422


def test_activity_summary_counts_connections_operators_devices_and_session_time(db):
    repo = AuditLogRepository(db)
    for operator, device_id in (("mario", 101), ("mario", 101), ("denis", 102), ("mario", 201)):
        repo.create(operator_id=1, operator_username=operator, action="remote_connect", entity_type="device",
                    entity_id=device_id)
    # One terminal session whose close was reported twice, and one SSH session.
    for reason in ("agent_gone", "operator_closed"):
        repo.create(operator_id=1, operator_username="mario", action="terminal_session_closed",
                    entity_type="terminal_session",
                    details={"device_id": 103, "session_id": "t1", "duration_seconds": 120, "reason": reason})
    repo.create(operator_id=1, operator_username="mario", action="ssh_session_ended", entity_type="ssh_session",
                details={"device_id": 103, "session_id": "s1", "duration_seconds": 30})
    repo.create(operator_id=None, operator_username="denis", action="remote_session_ended", entity_type="device",
                entity_id=102, details={"duration_minutes": 25})
    old = repo.create(operator_id=1, operator_username="mario", action="remote_connect", entity_type="device",
                      entity_id=101)
    old.created_at = utcnow().replace(tzinfo=None) - timedelta(days=40)
    db.commit()

    body = _api(db, _operator(db, "boss", role="admin")).get("/clients/1/activity/summary").json()
    assert body["days"] == 30
    assert body["remote_connects"] == 3
    assert body["remote_devices"] == 2
    assert body["terminal_sessions"] == 2
    assert body["terminal_seconds"] == 150
    assert (body["remote_sessions"], body["remote_minutes"]) == (1, 25)
    assert [(o["username"], o["remote_connects"]) for o in body["operators"]] == [("mario", 2), ("denis", 1)]
    assert [(d["name"], d["remote_connects"]) for d in body["devices"]] == [("host-101", 2), ("host-102", 1)]

    op = _operator(db, "partial")
    _team(db, op, device_id=102)
    partial = _api(db, op).get("/clients/1/activity/summary").json()
    assert partial["remote_connects"] == 1
    assert [d["name"] for d in partial["devices"]] == ["host-102"]
