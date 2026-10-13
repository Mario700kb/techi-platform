"""Client documentation pages: who can read and write them, search and order,
and that they leave a trail in the client's activity."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints import clients as clients_module
from app.core.auth import get_current_operator
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.client_document import ClientDocument
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.operator import Operator
from app.models.team import Team, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember
from app.schemas.client_document import MAX_BODY_CHARS
from app.services.client_service import ClientService

TABLES = [
    Client.__table__,
    ClientDocument.__table__,
    DeviceGroup.__table__,
    Device.__table__,
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
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine, tables=TABLES)
    session = sessionmaker(bind=engine)()
    session.add_all([
        Client(id=1, name="Northwind", slug="northwind", is_active=True),
        Client(id=2, name="Blue Harbor", slug="blue-harbor", is_active=True),
    ])
    session.commit()
    yield session
    session.close()


def _operator(db, username, role="operator", client_id=None):
    op = Operator(username=username, email=f"{username}@test.com", hashed_password="x", role=role,
                  is_active=True, is_superuser=False)
    db.add(op)
    db.commit()
    db.refresh(op)
    if client_id:
        team = Team(name=f"team-{username}", color="#f97316")
        db.add(team)
        db.commit()
        db.add_all([TeamMember(team_id=team.id, operator_id=op.id), TeamClientAccess(team_id=team.id, client_id=client_id)])
        db.commit()
    return op


def _api(db, op):
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: op
    app.include_router(clients_module.router, prefix="/clients")
    return TestClient(app)


def test_an_operator_writes_reads_edits_and_deletes_a_page(db):
    api = _api(db, _operator(db, "sabina", client_id=1))

    created = api.post("/clients/1/documents", json={
        "title": "  Network  ", "category": "network", "body": "## LAN\n\n- Gateway **10.0.0.1**",
    })
    assert created.status_code == 201
    doc = created.json()
    assert doc["title"] == "Network" and doc["created_by"] == "sabina"
    assert doc["excerpt"] == "LAN Gateway 10.0.0.1"

    updated = api.put(f"/clients/1/documents/{doc['id']}", json={"pinned": True, "body": "VLAN 20"}).json()
    assert updated["pinned"] is True and updated["body"] == "VLAN 20" and updated["updated_by"] == "sabina"
    assert api.get(f"/clients/1/documents/{doc['id']}").json()["body"] == "VLAN 20"

    assert api.delete(f"/clients/1/documents/{doc['id']}").status_code == 204
    assert api.get(f"/clients/1/documents/{doc['id']}").status_code == 404

    actions = [(a.action, a.client_id) for a in db.query(AuditLog).order_by(AuditLog.id)]
    assert actions == [
        ("client_document_created", 1),
        ("client_document_updated", 1),
        ("client_document_deleted", 1),
    ]


def test_readonly_reads_but_cannot_write(db):
    owner = _api(db, _operator(db, "boss", role="admin"))
    doc = owner.post("/clients/1/documents", json={"title": "Contacts"}).json()
    readonly = _api(db, _operator(db, "viewer", role="readonly", client_id=1))

    assert readonly.get("/clients/1/documents").status_code == 200
    assert readonly.post("/clients/1/documents", json={"title": "x"}).status_code == 403
    assert readonly.put(f"/clients/1/documents/{doc['id']}", json={"title": "x"}).status_code == 403
    assert readonly.delete(f"/clients/1/documents/{doc['id']}").status_code == 403


def test_another_clients_pages_are_not_found(db):
    owner = _api(db, _operator(db, "boss", role="admin"))
    doc = owner.post("/clients/2/documents", json={"title": "Blue Harbor only"}).json()
    outsider = _api(db, _operator(db, "outsider", client_id=1))

    assert outsider.get("/clients/2/documents").status_code == 404
    assert outsider.post("/clients/2/documents", json={"title": "x"}).status_code == 404
    # A page id under the wrong client is not reachable either.
    assert owner.get(f"/clients/1/documents/{doc['id']}").status_code == 404


def test_list_puts_pinned_first_then_latest_and_searches_title_and_body(db):
    api = _api(db, _operator(db, "boss", role="admin"))
    old = api.post("/clients/1/documents", json={"title": "Printers", "body": "HP on floor 2"}).json()
    api.post("/clients/1/documents", json={"title": "Wi-Fi", "category": "network", "body": "SSID clinic"})
    api.put(f"/clients/1/documents/{old['id']}", json={"pinned": True})

    assert [d["title"] for d in api.get("/clients/1/documents").json()] == ["Printers", "Wi-Fi"]
    assert [d["title"] for d in api.get("/clients/1/documents", params={"q": "floor"}).json()] == ["Printers"]
    assert [d["title"] for d in api.get("/clients/1/documents", params={"category": "network"}).json()] == ["Wi-Fi"]
    assert "body" not in api.get("/clients/1/documents").json()[0]


def test_limits_on_title_category_and_size(db):
    api = _api(db, _operator(db, "boss", role="admin"))
    assert api.post("/clients/1/documents", json={"title": ""}).status_code == 422
    assert api.post("/clients/1/documents", json={"title": "x", "category": "secrets"}).status_code == 422
    assert api.post("/clients/1/documents", json={"title": "x", "body": "a" * (MAX_BODY_CHARS + 1)}).status_code == 422


def test_deleting_a_client_removes_its_pages(db):
    api = _api(db, _operator(db, "boss", role="admin"))
    api.post("/clients/1/documents", json={"title": "Network"})
    api.post("/clients/2/documents", json={"title": "Keep me"})

    ClientService(db).delete_client(1)

    assert [d.title for d in db.query(ClientDocument)] == ["Keep me"]
