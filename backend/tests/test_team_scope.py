"""
Tests for team-based scope resolution, permission service, and team CRUD.
All tests are pure in-memory SQLite — no HTTP client needed.
"""

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models.client import Client
from app.models.operator import Operator
from app.models.operator_scope import OperatorScope
from app.models.team import Team, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember
from app.core.scope import AllowedScope, device_in_scope
from app.services.team_service import TeamService, TeamScopeService
from app.services.permission_service import (
    ROLE_PERMISSIONS,
    get_permissions_for_role,
    has_permission,
    permissions_summary,
    VIEW_DEVICES,
    MANAGE_OPERATORS,
    SYSTEM_SETTINGS,
    REMOTE_SUPPORT_CONNECT,
)


# ── DB fixture ────────────────────────────────────────────────────────────── #

TABLES = [
    Operator.__table__,
    Client.__table__,
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
