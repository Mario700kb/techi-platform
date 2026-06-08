"""
Tests for team-based scope resolution, permission service, and team CRUD.
All tests are pure in-memory SQLite — no HTTP client needed.
"""

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.operator import Operator
from app.models.operator_scope import OperatorScope
from app.models.team import Team, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember
from app.core.scope import AllowedScope, device_in_scope
from app.services.team_service import TeamService, TeamScopeService
from app.core.auth import get_operator_permissions, get_operator_scope, is_unrestricted
from app.services.permission_service import (
    ACTION_PERMISSION_MAP,
    DIAGNOSTICS,
    MAINTENANCE_MODE,
    REMOTE_SUPPORT_MANAGE,
    ROLE_PERMISSIONS,
    get_permissions_for_role,
    has_permission,
    permissions_summary,
    VIEW_DEVICES,
    MANAGE_OPERATORS,
    REMOTE_SUPPORT_CONNECT,
    RESTART_DEVICE,
    RESTART_AGENT,
    SYSTEM_SETTINGS,
)


# ── DB fixture ────────────────────────────────────────────────────────────── #

TABLES = [
    Operator.__table__,
    Client.__table__,
    DeviceGroup.__table__,
    Device.__table__,
    OperatorScope.__table__,
    Team.__table__,
    TeamMember.__table__,
    TeamClientAccess.__table__,
    TeamGroupAccess.__table__,
    TeamDeviceAccess.__table__,
]


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine, tables=TABLES)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


# ── Helpers ───────────────────────────────────────────────────────────────── #

def _team(db, name: str, color: str = "#f97316") -> Team:
    t = Team(name=name, color=color)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def _operator(db, username: str = "op1", role: str = "operator") -> Operator:
    op = Operator(
        username=username, email=f"{username}@test.com",
        hashed_password="x", role=role, is_active=True, is_superuser=False,
    )
    db.add(op)
    db.commit()
    db.refresh(op)
    return op


# ── Permission service ────────────────────────────────────────────────────── #

def test_owner_has_all_permissions():
    perms = get_permissions_for_role("owner")
    assert VIEW_DEVICES in perms
    assert MANAGE_OPERATORS in perms
    assert SYSTEM_SETTINGS in perms


def test_operator_cannot_manage_operators():
    assert not has_permission("operator", MANAGE_OPERATORS)


def test_readonly_can_only_view():
    perms = get_permissions_for_role("readonly")
    assert VIEW_DEVICES in perms
    assert not has_permission("readonly", REMOTE_SUPPORT_CONNECT)
    assert not has_permission("readonly", MANAGE_OPERATORS)


def test_admin_missing_system_settings():
    assert not has_permission("admin", SYSTEM_SETTINGS)


def test_permissions_summary_structure():
    s = permissions_summary("operator")
    assert s["role"] == "operator"
    assert VIEW_DEVICES in s["permissions"]
    assert MANAGE_OPERATORS in s["denied"]
    assert isinstance(s["permissions"], list)
    assert isinstance(s["denied"], list)


def test_unknown_role_gets_empty_permissions():
    assert get_permissions_for_role("ghost") == frozenset()


# ── AllowedScope + device_in_scope ────────────────────────────────────────── #

def test_none_scope_is_unrestricted():
    assert device_in_scope(1, 2, 99, None) is True


def test_device_matched_by_client():
    scope = AllowedScope(client_ids=frozenset({5}))
    assert device_in_scope(5, None, 99, scope) is True
    assert device_in_scope(6, None, 99, scope) is False


def test_device_matched_by_group():
    scope = AllowedScope(group_ids=frozenset({10}))
    assert device_in_scope(None, 10, 99, scope) is True
    assert device_in_scope(None, 11, 99, scope) is False


def test_device_matched_by_id():
    scope = AllowedScope(device_ids=frozenset({42}))
    assert device_in_scope(None, None, 42, scope) is True
    assert device_in_scope(None, None, 43, scope) is False


def test_empty_scope_blocks_all():
    scope = AllowedScope()
    assert device_in_scope(1, 2, 3, scope) is False


# ── TeamService ───────────────────────────────────────────────────────────── #

def test_create_and_list_teams(db):
    svc = TeamService(db)
    svc.create_team("IT Support", description="Helpdesk team")
    svc.create_team("NOC")
    teams = svc.list_teams()
    names = [t.name for t in teams]
    assert "IT Support" in names
    assert "NOC" in names


def test_get_team_returns_none_for_missing(db):
    assert TeamService(db).get_team(9999) is None


def test_delete_team(db):
    svc = TeamService(db)
    team = svc.create_team("Temp")
    assert svc.delete_team(team.id) is True
    assert svc.get_team(team.id) is None


def test_add_remove_member(db):
    svc = TeamService(db)
    team = svc.create_team("Alpha")
    op = _operator(db, "alice")
    svc.add_member(team.id, op.id)
    from app.repositories.team_repository import TeamRepository
    repo = TeamRepository(db)
    assert op.id in repo.get_operator_ids(team.id)
    svc.remove_member(team.id, op.id)
    assert op.id not in repo.get_operator_ids(team.id)


def test_replace_client_access(db):
    svc = TeamService(db)
    team = svc.create_team("Beta")
    svc.replace_client_access(team.id, [1, 2, 3])
    from app.repositories.team_repository import TeamRepository
    ids = TeamRepository(db).list_client_ids(team.id)
    assert set(ids) == {1, 2, 3}
    # Replace with different set
    svc.replace_client_access(team.id, [4, 5])
    ids2 = TeamRepository(db).list_client_ids(team.id)
    assert set(ids2) == {4, 5}


# ── TeamScopeService — union scope ───────────────────────────────────────── #

def test_team_scope_empty_when_no_teams(db):
    op = _operator(db, "noop")
    scope = TeamScopeService(db).get_team_scope_for_operator(op.id)
    assert scope.is_empty()


def test_team_scope_returns_client_ids(db):
    op = _operator(db, "ops1")
    svc = TeamService(db)
    team = svc.create_team("Gamma")
    svc.add_member(team.id, op.id)
    svc.replace_client_access(team.id, [10, 20])

    scope = TeamScopeService(db).get_team_scope_for_operator(op.id)
    assert 10 in scope.client_ids
    assert 20 in scope.client_ids


def test_team_scope_unions_multiple_teams(db):
    op = _operator(db, "ops2")
    svc = TeamService(db)

    t1 = svc.create_team("Delta1")
    svc.add_member(t1.id, op.id)
    svc.replace_client_access(t1.id, [100])

    t2 = svc.create_team("Delta2")
    svc.add_member(t2.id, op.id)
    svc.replace_client_access(t2.id, [200])
    svc.replace_group_access(t2.id, [55])

    scope = TeamScopeService(db).get_team_scope_for_operator(op.id)
    assert 100 in scope.client_ids
    assert 200 in scope.client_ids
    assert 55 in scope.group_ids


def test_team_scope_device_ids(db):
    op = _operator(db, "ops3")
    svc = TeamService(db)
    team = svc.create_team("Epsilon")
    svc.add_member(team.id, op.id)
    svc.replace_device_access(team.id, [77, 88])

    scope = TeamScopeService(db).get_team_scope_for_operator(op.id)
    assert 77 in scope.device_ids
    assert 88 in scope.device_ids


def test_scope_union_with_individual_and_team(db):
    """Individual OperatorScope + team scope should be unioned."""
    from app.repositories.operator_scope_repository import OperatorScopeRepository
    from app.services.operator_scope_service import OperatorScopeService
    from app.core.scope import AllowedScope

    op = _operator(db, "ops4")
    # Individual scope: client 1
    OperatorScopeRepository(db).create(op.id, "client", 1)
    individual = OperatorScopeService(db).get_allowed_scope(op.id)

    # Team scope: client 2
    svc = TeamService(db)
    team = svc.create_team("Zeta")
    svc.add_member(team.id, op.id)
    svc.replace_client_access(team.id, [2])
    team_scope = TeamScopeService(db).get_team_scope_for_operator(op.id)

    combined = AllowedScope(
        client_ids=individual.client_ids | team_scope.client_ids,
        group_ids=individual.group_ids | team_scope.group_ids,
        device_ids=individual.device_ids | team_scope.device_ids,
    )
    assert 1 in combined.client_ids
    assert 2 in combined.client_ids


# ── Team permissions ───────────────────────────────────────────────────────── #

def test_team_create_with_permissions(db):
    svc = TeamService(db)
    perms = ["view_devices", "remote_support_connect", "restart_device"]
    team = svc.create_team("Perm Team", permissions=perms)
    detail = svc.get_team_detail(team.id)
    assert set(detail["permissions"]) == set(perms)


def test_team_permissions_default_empty(db):
    svc = TeamService(db)
    team = svc.create_team("No Perms Team")
    detail = svc.get_team_detail(team.id)
    assert detail["permissions"] == []


def test_team_update_permissions(db):
    svc = TeamService(db)
    team = svc.create_team("Update Perms", permissions=["view_devices"])
    svc.update_team(team.id, permissions=["view_devices", "restart_device", "maintenance_mode"])
    detail = svc.get_team_detail(team.id)
    assert "restart_device" in detail["permissions"]
    assert "maintenance_mode" in detail["permissions"]
    assert len(detail["permissions"]) == 3


def test_team_clear_permissions(db):
    svc = TeamService(db)
    team = svc.create_team("Clear Perms", permissions=["view_devices", "restart_device"])
    svc.update_team(team.id, permissions=[])
    detail = svc.get_team_detail(team.id)
    assert detail["permissions"] == []


def test_team_stats_include_counts(db):
    svc = TeamService(db)
    team = svc.create_team("Stats Team")
    svc.replace_client_access(team.id, [1, 2])
    svc.replace_group_access(team.id, [10, 20, 30])
    stats = svc.team_stats(team.id)
    assert stats["client_count"] == 2
    assert stats["group_count"] == 3
    assert stats["member_count"] == 0


def test_list_teams_with_stats_returns_effective_union(db):
    svc = TeamService(db)
    first = svc.create_team("Bulk A")
    second = svc.create_team("Bulk B")
    svc.replace_client_access(first.id, [1])
    svc.replace_device_access(second.id, [2])
    db.add_all([
        Device(rustdesk_id="BULK-1", hostname="one", client_id=1),
        Device(rustdesk_id="BULK-2", hostname="two", client_id=2),
    ])
    db.commit()
    devices = db.query(Device).order_by(Device.id).all()
    svc.replace_device_access(second.id, [devices[1].id])

    rows = {row["name"]: row for row in svc.list_teams_with_stats()}

    assert rows["Bulk A"]["client_count"] == 1
    assert rows["Bulk A"]["effective_device_count"] == 1
    assert rows["Bulk B"]["explicit_device_count"] == 1
    assert rows["Bulk B"]["effective_device_count"] == 1


def test_list_teams_query_count_is_bounded(db):
    svc = TeamService(db)
    for index in range(20):
        svc.create_team(f"Query Team {index:02d}")

    statements = 0

    def count_statement(*_args):
        nonlocal statements
        statements += 1

    event.listen(db.get_bind(), "before_cursor_execute", count_statement)
    try:
        rows = svc.list_teams_with_stats()
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", count_statement)

    assert len(rows) == 20
    assert statements <= 6


# ── get_operator_permissions ───────────────────────────────────────────────── #

def test_effective_perms_admin_returns_none(db):
    admin = _operator(db, "admin1", role="admin")
    assert is_unrestricted(admin) is True
    result = get_operator_permissions(admin, db)
    assert result is None  # bypass sentinel


def test_effective_perms_owner_returns_none(db):
    owner = _operator(db, "owner1", role="owner")
    result = get_operator_permissions(owner, db)
    assert result is None


def test_effective_perms_operator_no_teams_is_empty(db):
    op = _operator(db, "lone_op", role="operator")
    result = get_operator_permissions(op, db)
    assert result == frozenset()


def test_effective_perms_operator_with_team_perms(db):
    op = _operator(db, "perm_op", role="operator")
    svc = TeamService(db)
    team = svc.create_team("Perm Team A", permissions=["restart_device", "diagnostics"])
    svc.add_member(team.id, op.id)

    result = get_operator_permissions(op, db)
    assert result is not None
    assert RESTART_DEVICE in result
    assert DIAGNOSTICS in result
    assert MAINTENANCE_MODE not in result


def test_effective_perms_operator_union_multiple_teams(db):
    op = _operator(db, "multi_perm_op", role="operator")
    svc = TeamService(db)
    t1 = svc.create_team("Union A", permissions=["restart_device"])
    t2 = svc.create_team("Union B", permissions=["maintenance_mode", "remote_support_connect"])
    svc.add_member(t1.id, op.id)
    svc.add_member(t2.id, op.id)

    result = get_operator_permissions(op, db)
    assert result is not None
    assert RESTART_DEVICE in result
    assert MAINTENANCE_MODE in result
    assert REMOTE_SUPPORT_CONNECT in result
    assert DIAGNOSTICS not in result


def test_effective_perms_readonly_no_teams_is_empty(db):
    ro = _operator(db, "readonly1", role="readonly")
    result = get_operator_permissions(ro, db)
    assert result == frozenset()


# ── Permission constants and mapping ──────────────────────────────────────── #

def test_new_permissions_in_role_definitions():
    assert DIAGNOSTICS in get_permissions_for_role("operator")
    assert REMOTE_SUPPORT_MANAGE in get_permissions_for_role("operator")
    assert DIAGNOSTICS not in get_permissions_for_role("readonly")
    assert REMOTE_SUPPORT_MANAGE not in get_permissions_for_role("readonly")
    assert DIAGNOSTICS in get_permissions_for_role("admin")
    assert REMOTE_SUPPORT_MANAGE in get_permissions_for_role("admin")


def test_action_permission_map_coverage():
    required_actions = {
        "ping", "immediate_heartbeat", "refresh_inventory", "sync_inventory",
        "sync_rustdesk", "restart_rustdesk", "reopen_rustdesk", "repair_config_rustdesk",
        "reinstall_rustdesk", "deploy_remote_support", "restart_agent",
        "restart_device", "apply_power_policy",
    }
    assert required_actions.issubset(set(ACTION_PERMISSION_MAP.keys()))


def test_action_permission_map_values():
    assert ACTION_PERMISSION_MAP["ping"] == DIAGNOSTICS
    assert ACTION_PERMISSION_MAP["restart_device"] == RESTART_DEVICE
    assert ACTION_PERMISSION_MAP["restart_agent"] == RESTART_AGENT
    assert ACTION_PERMISSION_MAP["sync_rustdesk"] == REMOTE_SUPPORT_MANAGE
    assert ACTION_PERMISSION_MAP["apply_power_policy"] == MAINTENANCE_MODE


# ── Scope leak regression ──────────────────────────────────────────────────── #

def test_legacy_operator_scope_does_not_leak_into_visibility(db):
    """Operator with a legacy operator_scopes record for Client A, who belongs
    to a Team that only grants access to Client B, must see ONLY Client B.
    Legacy individual scope records must NOT be merged into effective scope.
    """
    from app.models.operator_scope import OperatorScope

    op = _operator(db, "leak_op", role="operator")

    # Write a legacy operator_scopes record granting access to client_id=1 (Client A)
    legacy = OperatorScope(operator_id=op.id, scope_type="client", scope_id=1)
    db.add(legacy)
    db.commit()

    # Create a team that grants access only to client_id=2 (Client B)
    svc = TeamService(db)
    team = svc.create_team("Restricted Team")
    svc.add_member(team.id, op.id)
    svc.replace_client_access(team.id, [2])

    # Resolve effective scope
    scope = get_operator_scope(operator=op, db=db)

    # Client B must be visible
    assert 2 in scope.client_ids, "Client B (team access) must be visible"

    # Client A must NOT be visible — legacy record must be ignored
    assert 1 not in scope.client_ids, "Client A (legacy individual scope) must NOT leak through"


def test_operator_with_no_teams_sees_nothing_even_with_legacy_scope(db):
    """An operator with individual scope records but no team memberships
    should resolve to an empty scope — sees nothing.
    """
    from app.models.operator_scope import OperatorScope

    op = _operator(db, "no_team_op", role="operator")

    # Legacy individual scope for client_id=5
    legacy = OperatorScope(operator_id=op.id, scope_type="client", scope_id=5)
    db.add(legacy)
    db.commit()

    scope = get_operator_scope(operator=op, db=db)

    assert scope is not None, "Operator without teams must not get None (that is admin bypass)"
    assert scope.is_empty(), "Operator with legacy scope but no teams must see nothing"


def test_admin_still_bypasses_scope(db):
    """Admin must continue to receive None (unrestricted) regardless of team memberships."""
    admin = _operator(db, "admin_bypass", role="admin")
    scope = get_operator_scope(operator=admin, db=db)
    assert scope is None, "Admin must always receive None (bypass)"


def test_owner_still_bypasses_scope(db):
    """Owner must continue to receive None (unrestricted)."""
    owner = _operator(db, "owner_bypass", role="owner")
    scope = get_operator_scope(operator=owner, db=db)
    assert scope is None, "Owner must always receive None (bypass)"
