"""Client locations (sites): which rule places a device, what the operator
pins by hand, the suggestions from shared public IPs, the Explorer filter
and counts, and who may change them."""
import json
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints import clients as clients_module
from app.core.auth import get_current_operator
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.client_location import ClientLocation, ClientLocationRule
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.operator import Operator
from app.models.team import Team, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember
from app.repositories.device_repository import DeviceRepository
from app.services.device_overview_service import invalidate_overview_cache
from app.services.location_service import RuleMatcher, lan_of

TABLES = [
    Client.__table__,
    ClientLocation.__table__,
    ClientLocationRule.__table__,
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

HQ_IP = "80.90.87.187"
BRANCH_IP = "84.22.48.82"


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine, tables=TABLES)
    session = sessionmaker(bind=engine)()
    session.add_all([
        Client(id=1, name="Vasgroup", slug="vasgroup", is_active=True),
        Client(id=2, name="Metropol", slug="metropol", is_active=True),
        DeviceGroup(id=1, client_id=1, name="Client PC"),
        DeviceGroup(id=2, client_id=1, name="Servers"),
    ])
    session.commit()
    invalidate_overview_cache()
    yield session
    session.close()
    invalidate_overview_cache()


def _device(db, device_id, *, public_ip, local_ip, client_id=1, group_id=1, online=True, **extra):
    db.add(Device(
        id=device_id, rustdesk_id=f"RD-{device_id}", hostname=f"host-{device_id}", client_id=client_id,
        group_id=group_id, device_type="client", status="online" if online else "offline",
        last_seen=utcnow() - (timedelta(seconds=20) if online else timedelta(days=2)),
        rustdesk_install_status="unknown", rustdesk_status="unknown", rustdesk_sync_state="unknown",
        assignment_source="manual", public_ip=public_ip, local_ip=local_ip, **extra,
    ))
    db.commit()


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


def _location(db, location_id: int):
    db.expire_all()
    return {d.id: d.location_id for d in db.query(Device).order_by(Device.id)}


# ── rules ────────────────────────────────────────────────────────────────────


def test_the_most_specific_rule_wins():
    hq = ClientLocation(id=1, client_id=1, name="Tiranë – HQ", kind="office", country="AL", city="Tiranë")
    hq.rules = [ClientLocationRule(public_ip=HQ_IP)]
    warehouse = ClientLocation(id=2, client_id=1, name="Tiranë – Magazina", kind="warehouse", country="AL", city="Tiranë")
    warehouse.rules = [ClientLocationRule(public_ip=HQ_IP, lan_cidr="10.130.50.0/24")]
    vpn = ClientLocation(id=3, client_id=1, name="Durrës – Dega", kind="branch", country="AL", city="Durrës")
    vpn.rules = [ClientLocationRule(lan_cidr="10.133.0.0/16")]
    matcher = RuleMatcher([hq, warehouse, vpn])

    assert matcher.match(HQ_IP, "10.130.10.5") == 1  # the HQ line
    assert matcher.match(HQ_IP, "10.130.50.7") == 2  # same line, the warehouse LAN
    assert matcher.match(HQ_IP, "10.133.2.9") == 3  # a branch over the VPN: its LAN beats the HQ's IP
    assert matcher.match("1.2.3.4", "10.133.1.1") == 3
    assert matcher.match("1.2.3.4", "192.168.1.10") is None


def test_virtual_adapters_are_not_a_site_network():
    assert lan_of("10.130.50.7") == "10.130.50.0/24"
    assert lan_of("192.168.1.20") == "192.168.1.0/24"
    for virtual in ("169.254.12.3", "100.72.137.4", "26.156.91.2", "25.1.2.3", "fe80::1", "", None, "x"):
        assert lan_of(virtual) is None


# ── API ──────────────────────────────────────────────────────────────────────


def test_a_location_places_the_devices_its_rules_recognise(db):
    for i in range(1, 5):
        _device(db, i, public_ip=HQ_IP, local_ip=f"10.130.10.{i}")
    _device(db, 5, public_ip=HQ_IP, local_ip="10.130.50.5", group_id=2)
    _device(db, 6, public_ip=BRANCH_IP, local_ip="10.133.1.6")
    _device(db, 7, public_ip=HQ_IP, local_ip="10.130.10.7", client_id=2, group_id=None)  # another client, same IP
    api = _api(db, _operator(db, "boss", role="admin"))

    hq = api.post("/clients/1/locations", json={
        "name": " Tiranë – Zyra qendrore ", "kind": "office", "country": "al", "city": "Tiranë",
        "rules": [{"public_ip": HQ_IP}],
    })
    assert hq.status_code == 201, hq.text
    body = hq.json()
    assert body["name"] == "Tiranë – Zyra qendrore" and body["country"] == "AL"
    assert body["stats"]["total"] == 5 and body["stats"]["servers"] == 1 and body["stats"]["clientpc"] == 4
    placed = _location(db, 0)
    assert all(placed[i] == body["id"] for i in range(1, 6))
    assert placed[6] is None and placed[7] is None  # the other client keeps its own sites

    warehouse = api.post("/clients/1/locations", json={
        "name": "Tiranë – Magazina", "kind": "warehouse", "country": "AL", "city": "Tiranë",
        "rules": [{"public_ip": HQ_IP, "lan_cidr": "10.130.50.9/24"}],
    }).json()
    assert warehouse["rules"][0]["lan_cidr"] == "10.130.50.0/24"
    assert _location(db, 0)[5] == warehouse["id"]

    listing = api.get("/clients/1/locations").json()
    assert [loc["name"] for loc in listing["locations"]] == ["Tiranë – Magazina", "Tiranë – Zyra qendrore"]
    assert listing["unlocated"]["total"] == 1

    # Deleting the warehouse gives its device back to the HQ rule.
    assert api.delete(f"/clients/1/locations/{warehouse['id']}").status_code == 204
    assert _location(db, 0)[5] == body["id"]
    actions = [a.action for a in db.query(AuditLog).order_by(AuditLog.id)]
    assert actions == ["client_location_created", "client_location_created", "client_location_deleted"]


def test_a_pinned_device_stays_where_the_operator_put_it(db):
    for i in range(1, 4):
        _device(db, i, public_ip=HQ_IP, local_ip=f"10.130.10.{i}")
    api = _api(db, _operator(db, "boss", role="admin"))
    hq = api.post("/clients/1/locations", json={
        "name": "HQ", "country": "AL", "city": "Tiranë", "rules": [{"public_ip": HQ_IP}],
    }).json()
    shop = api.post("/clients/1/locations", json={"name": "Shop", "kind": "shop", "country": "AL", "city": "Durrës"}).json()

    assert api.post("/clients/1/locations/assign", json={"device_ids": [2], "location_id": shop["id"]}).status_code == 200
    # Rules run again (an edit) and leave the pinned device alone.
    api.put(f"/clients/1/locations/{hq['id']}", json={"rules": [{"public_ip": HQ_IP}]})
    placed = _location(db, 0)
    assert placed[1] == hq["id"] and placed[2] == shop["id"] and placed[3] == hq["id"]
    assert db.get(Device, 2).location_source == "manual"

    # Back to the rules.
    api.post("/clients/1/locations/assign", json={"device_ids": [2], "mode": "auto"})
    db.expire_all()
    assert db.get(Device, 2).location_id == hq["id"] and db.get(Device, 2).location_source == "rule"

    # A location of another client cannot be used.
    other = ClientLocation(client_id=2, name="Elsewhere", kind="office", country="AL", city="Vlorë",
                           created_at=utcnow(), updated_at=utcnow())
    db.add(other)
    db.commit()
    assert api.post("/clients/1/locations/assign", json={"device_ids": [2], "location_id": other.id}).status_code == 404


def test_suggestions_come_from_ips_several_unlocated_devices_share(db):
    for i in range(1, 5):
        _device(db, i, public_ip=HQ_IP, local_ip=f"10.130.10.{i}")
    for i in range(5, 8):
        _device(db, i, public_ip=HQ_IP, local_ip=f"10.130.50.{i}", online=False)
    _device(db, 8, public_ip=HQ_IP, local_ip="169.254.1.8")  # a virtual adapter, no network
    _device(db, 9, public_ip=BRANCH_IP, local_ip="10.133.1.9")  # two devices: a home line, not a site
    _device(db, 10, public_ip=BRANCH_IP, local_ip="10.133.1.10")
    _device(db, 11, public_ip="10.0.0.1", local_ip="10.0.0.11")  # not a public address
    api = _api(db, _operator(db, "boss", role="admin"))

    suggestions = api.get("/clients/1/locations/suggestions").json()
    assert len(suggestions) == 1
    hq = suggestions[0]
    assert hq["public_ip"] == HQ_IP and hq["devices"] == 8 and hq["online"] == 5
    assert hq["networks"] == [
        {"lan_cidr": "10.130.10.0/24", "devices": 4},
        {"lan_cidr": "10.130.50.0/24", "devices": 3},
    ]
    assert hq["other_network_devices"] == 1

    # A site made from one network leaves the IP's other devices suggested.
    api.post("/clients/1/locations", json={"name": "Magazina", "country": "AL", "city": "Tiranë",
                                           "rules": [{"public_ip": HQ_IP, "lan_cidr": "10.130.50.0/24"}]})
    [rest] = api.get("/clients/1/locations/suggestions").json()
    assert rest["devices"] == 5 and rest["networks"] == [{"lan_cidr": "10.130.10.0/24", "devices": 4}]

    # Once a rule places the rest, the IP is no longer suggested.
    api.post("/clients/1/locations", json={"name": "HQ", "country": "AL", "city": "Tiranë",
                                           "rules": [{"public_ip": HQ_IP}]})
    assert api.get("/clients/1/locations/suggestions").json() == []

    # A device put at "no location" by hand is not suggested again.
    for i in range(20, 23):
        _device(db, i, public_ip="9.9.9.9", local_ip=f"10.9.9.{i}", location_source="manual")
    assert api.get("/clients/1/locations/suggestions").json() == []


def test_only_operators_who_manage_clients_change_locations(db):
    _device(db, 1, public_ip=HQ_IP, local_ip="10.130.10.1")
    viewer = _api(db, _operator(db, "sabina", client_id=1))
    assert viewer.get("/clients/1/locations").status_code == 200
    assert viewer.get("/clients/1/locations/suggestions").status_code == 200
    assert viewer.post("/clients/1/locations", json={"name": "x", "country": "AL", "city": "y"}).status_code == 403
    assert viewer.post("/clients/1/locations/assign", json={"device_ids": [1]}).status_code == 403
    # A client outside the operator's teams does not exist for them.
    assert viewer.get("/clients/2/locations").status_code == 404


def test_invalid_input_is_refused(db):
    api = _api(db, _operator(db, "boss", role="admin"))
    base = {"name": "HQ", "country": "AL", "city": "Tiranë"}
    assert api.post("/clients/1/locations", json={**base, "rules": [{}]}).status_code == 422
    assert api.post("/clients/1/locations", json={**base, "rules": [{"public_ip": "999.1.1.1"}]}).status_code == 422
    assert api.post("/clients/1/locations", json={**base, "rules": [{"lan_cidr": "10.0.0.0/99"}]}).status_code == 422
    assert api.post("/clients/1/locations", json={**base, "country": "ALB"}).status_code == 422
    assert api.post("/clients/1/locations", json={**base, "city": "  "}).status_code == 422
    assert api.post("/clients/1/locations", json=base).status_code == 201
    assert api.post("/clients/1/locations", json={**base, "name": "hq"}).status_code == 409


# ── Explorer ─────────────────────────────────────────────────────────────────


def test_the_explorer_filters_and_counts_by_location(db):
    for i in range(1, 4):
        _device(db, i, public_ip=HQ_IP, local_ip=f"10.130.10.{i}")
    _device(db, 4, public_ip=HQ_IP, local_ip="10.130.10.4", group_id=2, online=False)
    _device(db, 5, public_ip="5.6.7.8", local_ip="192.168.1.5")
    api = _api(db, _operator(db, "boss", role="admin"))
    hq = api.post("/clients/1/locations", json={"name": "HQ", "country": "AL", "city": "Tiranë",
                                                "rules": [{"public_ip": HQ_IP}]}).json()

    repo = DeviceRepository(db)
    assert repo.count(client_id=1, location_ids=[hq["id"]]) == 4
    assert repo.count(client_id=1, location_ids=[-1]) == 1
    assert repo.count(client_id=1, location_ids=[hq["id"], -1]) == 5
    assert repo.count(client_id=1, location_ids=[]) == 0

    rows = {(r[1], r[2]): r[4:] for r in repo.count_by_client_location()}
    # (location, category) → (total, online, stale, offline)
    assert rows[(hq["id"], "clientpc")] == (3, 3, 0, 0)
    assert rows[(hq["id"], "servers")] == (1, 0, 0, 1)
    assert rows[(None, "clientpc")] == (1, 1, 0, 0)


def test_a_device_that_moves_to_another_client_leaves_its_site(db):
    _device(db, 1, public_ip=HQ_IP, local_ip="10.130.10.1")
    api = _api(db, _operator(db, "boss", role="admin"))
    hq = api.post("/clients/1/locations", json={"name": "HQ", "country": "AL", "city": "Tiranë",
                                                "rules": [{"public_ip": HQ_IP}]}).json()
    device = db.get(Device, 1)
    assert device.location_id == hq["id"] and device.location_name == "HQ"
    device.client_id = 2
    db.commit()
    db.expire_all()
    device = db.get(Device, 1)
    assert device.location_id is None and device.location_source is None and device.location_name is None


def test_the_sweep_places_new_and_moved_devices_and_says_so_only_when_something_moved(db):
    from app.services.location_service import sweep_location_rules

    _device(db, 1, public_ip=HQ_IP, local_ip="10.130.10.1")
    api = _api(db, _operator(db, "boss", role="admin"))
    hq = api.post("/clients/1/locations", json={"name": "HQ", "country": "AL", "city": "Tiranë",
                                                "rules": [{"public_ip": HQ_IP}]}).json()
    branch = api.post("/clients/1/locations", json={"name": "Dega", "country": "AL", "city": "Durrës",
                                                    "rules": [{"public_ip": BRANCH_IP}]}).json()
    # A device enrolled after the sites were made, and one whose line changed.
    _device(db, 2, public_ip=HQ_IP, local_ip="10.130.10.2")
    moved = db.get(Device, 1)
    moved.public_ip = BRANCH_IP
    db.commit()

    result = sweep_location_rules(db)
    assert (result.assigned, result.cleared) == (2, 0)
    placed = _location(db, 0)
    assert placed[1] == branch["id"] and placed[2] == hq["id"]
    entry = db.query(AuditLog).filter(AuditLog.action == "client_locations_applied").one()
    assert entry.operator_username == "system" and entry.client_id == 1
    details = json.loads(entry.details_json)
    assert details["trigger"] == "schedule" and details["assigned"] == 2

    # Nothing moved: nothing written.
    assert (sweep_location_rules(db).assigned, sweep_location_rules(db).cleared) == (0, 0)
    assert db.query(AuditLog).filter(AuditLog.action == "client_locations_applied").count() == 1


def test_re_applying_rules_by_hand_is_audited(db):
    _device(db, 1, public_ip=HQ_IP, local_ip="10.130.10.1")
    api = _api(db, _operator(db, "boss", role="admin"))
    api.post("/clients/1/locations", json={"name": "HQ", "country": "AL", "city": "Tiranë"})
    result = api.post("/clients/1/locations/apply").json()
    assert result == {"assigned": 0, "cleared": 0}
    entry = db.query(AuditLog).filter(AuditLog.action == "client_locations_applied").one()
    assert entry.operator_username == "boss" and json.loads(entry.details_json)["trigger"] == "manual"
