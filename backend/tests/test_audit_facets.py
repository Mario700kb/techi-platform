"""The audit filters list what the log holds, not a hand-kept subset.

The console's action list had 18 entries while production's most common
actions (remote_connect, terminal and ssh sessions, package and token
changes) were missing, so most of the log could not be filtered.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.client_location import ClientLocation, ClientLocationRule
from app.repositories.audit_log_repository import AuditLogRepository


def test_facets_count_every_action_entity_and_operator():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine, tables=[AuditLog.__table__, ClientLocation.__table__, ClientLocationRule.__table__, Device.__table__])
    db = sessionmaker(bind=engine)()
    repo = AuditLogRepository(db)
    for _ in range(3):
        repo.create(operator_id=1, operator_username="denis", action="remote_connect", entity_type="device", entity_id=291)
    repo.create(operator_id=2, operator_username="mario", action="login")
    repo.create(operator_id=None, operator_username="system", action="nightly_cleanup")

    facets = repo.facets()

    assert facets["actions"][0] == {"value": "remote_connect", "count": 3}
    assert {f["value"] for f in facets["actions"]} == {"remote_connect", "login", "nightly_cleanup"}
    assert facets["entity_types"] == [{"value": "device", "count": 3}], "events without an entity are not a type"
    assert facets["operators"][0] == {"value": "denis", "count": 3}
