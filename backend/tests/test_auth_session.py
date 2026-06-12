import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints import auth as auth_module
from app.core.auth import get_current_operator
from app.db.base import Base
from app.db.session import get_db
from app.models.operator import Operator
from app.models.team import Team, TeamMember
from app.services.permission_service import AUDIT_LOG, VIEW_DEVICES


TABLES = [
    Operator.__table__,
    Team.__table__,
    TeamMember.__table__,
]


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine, tables=TABLES)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _operator(db, role: str = "operator") -> Operator:
    operator = Operator(
        username=f"{role}-session",
        email=f"{role}-session@test.com",
        hashed_password="x",
        role=role,
        is_active=True,
        is_superuser=False,
    )
    db.add(operator)
    db.commit()
    db.refresh(operator)
    return operator


def _client(db, operator: Operator) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.include_router(auth_module.router, prefix="/auth")
    return TestClient(app, raise_server_exceptions=False)


def test_auth_session_combines_user_and_team_permissions(db):
    operator = _operator(db)
    team = Team(
        name="Session Team",
        color="#f97316",
        permissions=json.dumps([VIEW_DEVICES, AUDIT_LOG]),
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    db.add(TeamMember(team_id=team.id, operator_id=operator.id))
    db.commit()

    response = _client(db, operator).get("/auth/session")

    assert response.status_code == 200
    body = response.json()
    assert body["user"]["id"] == operator.id
    assert body["permissions"] == sorted([AUDIT_LOG, VIEW_DEVICES])
    assert AUDIT_LOG not in body["denied"]


def test_auth_session_returns_role_permissions_for_admin(db):
    admin = _operator(db, role="admin")

    response = _client(db, admin).get("/auth/session")

    assert response.status_code == 200
    body = response.json()
    assert body["user"]["role"] == "admin"
    assert VIEW_DEVICES in body["permissions"]
