"""PATCH /auth/me: an operator edits their own display name and email; a new
email needs the current password and must not belong to anyone else."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints import auth as auth_module
from app.core.auth import get_current_operator, hash_password
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.operator import Operator

TABLES = [Operator.__table__, AuditLog.__table__]


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine, tables=TABLES)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _operator(db, username, email, password="correct-horse"):
    op = Operator(username=username, email=email, hashed_password=hash_password(password), role="operator",
                  is_active=True, is_superuser=False)
    db.add(op)
    db.commit()
    db.refresh(op)
    return op


def _api(db, op):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: op
    app.include_router(auth_module.router, prefix="/auth")
    return TestClient(app, raise_server_exceptions=True)


def test_display_name_changes_without_a_password_and_is_audited(db):
    op = _operator(db, "denis", "denis@techi.al")
    body = _api(db, op).patch("/auth/me", json={"display_name": "  Denis Zoi  "}).json()

    assert body["display_name"] == "Denis Zoi"
    assert body["username"] == "denis"
    entry = db.query(AuditLog).one()
    assert entry.action == "operator_updated"
    assert json.loads(entry.details_json)["fields"] == ["display_name"]


def test_a_blank_display_name_falls_back_to_the_username(db):
    op = _operator(db, "denis", "denis@techi.al")
    op.display_name = "Denis"
    db.commit()
    body = _api(db, op).patch("/auth/me", json={"display_name": "   "}).json()
    assert body["display_name"] is None


def test_a_new_email_needs_the_current_password(db):
    op = _operator(db, "denis", "denis@techi.al")
    api = _api(db, op)

    missing = api.patch("/auth/me", json={"email": "new@techi.al"})
    assert missing.status_code == 400 and "current password" in missing.json()["detail"]
    wrong = api.patch("/auth/me", json={"email": "new@techi.al", "current_password": "nope"})
    assert wrong.status_code == 400 and wrong.json()["detail"] == "Current password is incorrect"
    db.refresh(op)
    assert op.email == "denis@techi.al"

    ok = api.patch("/auth/me", json={"email": "New@Techi.al", "current_password": "correct-horse"})
    assert ok.status_code == 200 and ok.json()["email"] == "new@techi.al"
    details = json.loads(db.query(AuditLog).one().details_json)
    assert (details["email_from"], details["email_to"]) == ("denis@techi.al", "new@techi.al")


def test_an_email_used_by_another_operator_is_refused(db):
    _operator(db, "mario", "mario@techi.al")
    op = _operator(db, "denis", "denis@techi.al")
    taken = _api(db, op).patch("/auth/me", json={"email": "MARIO@techi.al", "current_password": "correct-horse"})
    assert taken.status_code == 400 and "already uses" in taken.json()["detail"]


def test_username_and_role_cannot_be_changed_here(db):
    op = _operator(db, "denis", "denis@techi.al")
    body = _api(db, op).patch("/auth/me", json={"username": "boss", "role": "owner", "display_name": "D"}).json()
    assert (body["username"], body["role"], body["display_name"]) == ("denis", "operator", "D")


def test_the_same_email_needs_no_password_and_writes_nothing(db):
    op = _operator(db, "denis", "denis@techi.al")
    assert _api(db, op).patch("/auth/me", json={"email": "Denis@techi.al"}).status_code == 200
    assert db.query(AuditLog).count() == 0
