"""
Tests for permission-based endpoint access control.

Verifies that operator/readonly accounts with team permissions can access
the corresponding endpoints, and that those without the permission receive 403.
Admin/owner bypass is also validated.

Uses in-memory SQLite + FastAPI TestClient — no live server required.
"""

import json
import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.models.team import Team, TeamMember
from app.core.auth import get_current_operator, require_team_permission, get_operator_permissions
from app.services.permission_service import (
    AUDIT_LOG,
    DEPLOYMENT,
    MANAGE_CLIENTS,
    MANAGE_GROUPS,
    MANAGE_OPERATORS,
    VIEW_DEVICES,
    VIEW_INVENTORY,
)

# ── Tables needed for these tests ────────────────────────────────────────── #

TABLES = [
    Operator.__table__,
    Team.__table__,
    TeamMember.__table__,
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


# ── Helpers ──────────────────────────────────────────────────────────────── #

def _operator(db: Session, username: str = "op", role: str = "operator") -> Operator:
    op = Operator(
        username=username,
        email=f"{username}@test.com",
        hashed_password="x",
        role=role,
        is_active=True,
        is_superuser=False,
    )
    db.add(op)
    db.commit()
    db.refresh(op)
    return op


_team_counter = 0

def _team_with_perms(db: Session, operator: Operator, perms: list[str]) -> Team:
    global _team_counter
    _team_counter += 1
    team = Team(name=f"Team-{_team_counter}", color="#f97316", permissions=json.dumps(perms))
    db.add(team)
    db.commit()
    db.refresh(team)
    member = TeamMember(team_id=team.id, operator_id=operator.id)
    db.add(member)
    db.commit()
    return team


def _make_client(db: Session, operator: Operator) -> TestClient:
    """Build a minimal FastAPI test app that wraps require_team_permission."""
    app = FastAPI()

    # Override get_db to use our in-memory session.
    app.dependency_overrides[get_db] = lambda: db
    # Override get_current_operator to return our test operator.
    app.dependency_overrides[get_current_operator] = lambda: operator

    @app.get("/audit", dependencies=[Depends(require_team_permission(AUDIT_LOG))])
    def audit_endpoint():
        return {"ok": True}

    @app.get("/operators", dependencies=[Depends(require_team_permission(MANAGE_OPERATORS))])
    def operators_endpoint():
        return {"ok": True}

    @app.get("/deployment", dependencies=[Depends(require_team_permission(DEPLOYMENT))])
    def deployment_endpoint():
        return {"ok": True}

    @app.get("/clients-write", dependencies=[Depends(require_team_permission(MANAGE_CLIENTS))])
    def clients_write_endpoint():
        return {"ok": True}

    @app.get("/groups-write", dependencies=[Depends(require_team_permission(MANAGE_GROUPS))])
    def groups_write_endpoint():
        return {"ok": True}

    @app.get("/inventory", dependencies=[Depends(require_team_permission(VIEW_INVENTORY))])
    def inventory_endpoint():
        return {"ok": True}

    return TestClient(app, raise_server_exceptions=False)


# ── get_operator_permissions unit tests ──────────────────────────────────── #

def test_admin_gets_none_bypass(db):
    admin = _operator(db, "admin1", role="admin")
    assert get_operator_permissions(admin, db) is None


def test_owner_gets_none_bypass(db):
    owner = _operator(db, "owner1", role="owner")
    assert get_operator_permissions(owner, db) is None


def test_operator_with_no_teams_gets_empty_permissions(db):
    op = _operator(db, "op_noteam")
    perms = get_operator_permissions(op, db)
    assert perms is not None
    assert len(perms) == 0


def test_operator_gets_team_permissions(db):
    op = _operator(db, "op_withperms")
    _team_with_perms(db, op, [AUDIT_LOG, MANAGE_OPERATORS])
    perms = get_operator_permissions(op, db)
    assert AUDIT_LOG in perms
    assert MANAGE_OPERATORS in perms
    assert DEPLOYMENT not in perms


def test_operator_unions_permissions_across_teams(db):
    op = _operator(db, "op_multiteam")
    _team_with_perms(db, op, [AUDIT_LOG])
    _team_with_perms(db, op, [DEPLOYMENT])
    perms = get_operator_permissions(op, db)
    assert AUDIT_LOG in perms
    assert DEPLOYMENT in perms


# ── Endpoint access tests via TestClient ─────────────────────────────────── #

class TestAuditLogPermission:
    def test_operator_with_audit_log_can_access(self, db):
        op = _operator(db, "op_audit")
        _team_with_perms(db, op, [AUDIT_LOG])
        client = _make_client(db, op)
        assert client.get("/audit").status_code == 200

    def test_operator_without_audit_log_gets_403(self, db):
        op = _operator(db, "op_noaudit")
        _team_with_perms(db, op, [VIEW_DEVICES])
        client = _make_client(db, op)
        assert client.get("/audit").status_code == 403

    def test_operator_with_no_teams_gets_403(self, db):
        op = _operator(db, "op_noteam_audit")
        client = _make_client(db, op)
        assert client.get("/audit").status_code == 403

    def test_admin_bypasses_audit_log_permission(self, db):
        admin = _operator(db, "admin_audit", role="admin")
        client = _make_client(db, admin)
        assert client.get("/audit").status_code == 200

    def test_owner_bypasses_audit_log_permission(self, db):
        owner = _operator(db, "owner_audit", role="owner")
        client = _make_client(db, owner)
        assert client.get("/audit").status_code == 200


class TestManageOperatorsPermission:
    def test_operator_with_manage_operators_can_access(self, db):
        op = _operator(db, "op_mgrops")
        _team_with_perms(db, op, [MANAGE_OPERATORS])
        client = _make_client(db, op)
        assert client.get("/operators").status_code == 200

    def test_operator_without_manage_operators_gets_403(self, db):
        op = _operator(db, "op_nomgrops")
        _team_with_perms(db, op, [VIEW_DEVICES])
        client = _make_client(db, op)
        assert client.get("/operators").status_code == 403

    def test_admin_bypasses_manage_operators(self, db):
        admin = _operator(db, "admin_ops", role="admin")
        client = _make_client(db, admin)
        assert client.get("/operators").status_code == 200


class TestDeploymentPermission:
    def test_operator_with_deployment_can_access_deployment(self, db):
        op = _operator(db, "op_deploy")
        _team_with_perms(db, op, [DEPLOYMENT])
        client = _make_client(db, op)
        assert client.get("/deployment").status_code == 200

    def test_operator_without_deployment_gets_403_on_deployment(self, db):
        op = _operator(db, "op_nodeploy")
        _team_with_perms(db, op, [VIEW_DEVICES])
        client = _make_client(db, op)
        assert client.get("/deployment").status_code == 403

    def test_admin_bypasses_deployment(self, db):
        admin = _operator(db, "admin_deploy", role="admin")
        client = _make_client(db, admin)
        assert client.get("/deployment").status_code == 200


class TestManageClientsPermission:
    def test_operator_with_manage_clients_can_write(self, db):
        op = _operator(db, "op_clients")
        _team_with_perms(db, op, [MANAGE_CLIENTS])
        client = _make_client(db, op)
        assert client.get("/clients-write").status_code == 200

    def test_operator_without_manage_clients_gets_403(self, db):
        op = _operator(db, "op_noclients")
        _team_with_perms(db, op, [VIEW_DEVICES])
        client = _make_client(db, op)
        assert client.get("/clients-write").status_code == 403

    def test_admin_bypasses_manage_clients(self, db):
        admin = _operator(db, "admin_clients", role="admin")
        client = _make_client(db, admin)
        assert client.get("/clients-write").status_code == 200


class TestManageGroupsPermission:
    def test_operator_with_manage_groups_can_write(self, db):
        op = _operator(db, "op_groups")
        _team_with_perms(db, op, [MANAGE_GROUPS])
        client = _make_client(db, op)
        assert client.get("/groups-write").status_code == 200

    def test_operator_without_manage_groups_gets_403(self, db):
        op = _operator(db, "op_nogroups")
        _team_with_perms(db, op, [VIEW_DEVICES])
        client = _make_client(db, op)
        assert client.get("/groups-write").status_code == 403


class TestInventoryPermission:
    def test_operator_with_view_inventory_can_access(self, db):
        op = _operator(db, "op_inv")
        _team_with_perms(db, op, [VIEW_INVENTORY])
        client = _make_client(db, op)
        assert client.get("/inventory").status_code == 200

    def test_operator_without_view_inventory_gets_403(self, db):
        op = _operator(db, "op_noinv")
        _team_with_perms(db, op, [VIEW_DEVICES])
        client = _make_client(db, op)
        assert client.get("/inventory").status_code == 403

    def test_admin_bypasses_inventory(self, db):
        admin = _operator(db, "admin_inv", role="admin")
        client = _make_client(db, admin)
        assert client.get("/inventory").status_code == 200


class TestReadonlyRolePermissions:
    def test_readonly_with_team_audit_log_can_access(self, db):
        ro = _operator(db, "ro_audit", role="readonly")
        _team_with_perms(db, ro, [AUDIT_LOG])
        client = _make_client(db, ro)
        assert client.get("/audit").status_code == 200

    def test_readonly_without_any_permission_gets_403(self, db):
        ro = _operator(db, "ro_empty", role="readonly")
        client = _make_client(db, ro)
        assert client.get("/audit").status_code == 403


class TestScopeRemainsActive:
    """Verify that granting a permission does not bypass scope (device visibility)."""

    def test_operator_with_manage_clients_still_lacks_view_devices_by_default(self, db):
        op = _operator(db, "op_scope")
        # Only manage_clients — no view_devices
        _team_with_perms(db, op, [MANAGE_CLIENTS])
        perms = get_operator_permissions(op, db)
        assert MANAGE_CLIENTS in perms
        assert VIEW_DEVICES not in perms

    def test_separate_permissions_are_not_implied(self, db):
        op = _operator(db, "op_implied")
        _team_with_perms(db, op, [DEPLOYMENT])
        perms = get_operator_permissions(op, db)
        assert DEPLOYMENT in perms
        assert MANAGE_OPERATORS not in perms
        assert AUDIT_LOG not in perms
