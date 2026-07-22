"""Component Action Execution Layer (Platform Components — Operational, M4).

Proves the resolver is wired to the EXISTING device-action mechanism and NOT a
parallel system: a component action, once queued, is stored as an ordinary
RemoteAction and flows through the full existing pipeline — heartbeat delivery →
acknowledge → running → complete — driven entirely by RemoteActionService. Also
covers the reverse attribution seam (RemoteAction → component/operation).
"""
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.remote_action import ActionStatus, RemoteAction
from app.services.component_action_service import ComponentActionService
from app.services.remote_action_service import RemoteActionService


def _db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=7, hostname="win-1", platform="windows", capabilities=None,
        device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE,
    ))
    db.commit()
    return db


def _device(db):
    return db.query(Device).filter(Device.id == 7).first()


def test_component_action_is_a_plain_remote_action():
    db = _db()
    result = ComponentActionService(db).execute(
        _device(db), "remote_support", "restart", created_by="mario"
    )
    action = result.action
    # Stored in the ONE RemoteAction table — no parallel store.
    rows = db.query(RemoteAction).all()
    assert len(rows) == 1
    assert rows[0].id == action.id
    assert action.action_type == "restart_rustdesk"
    assert action.status == ActionStatus.QUEUED
    assert action.created_by == "mario"


def test_flows_through_the_existing_pipeline_to_completion():
    db = _db()
    svc = ComponentActionService(db)
    rsvc = RemoteActionService(db)
    result = svc.execute(_device(db), "agent", "update", created_by="mario")
    action_id = result.action.id

    # Heartbeat delivery — the SAME collector every action uses.
    deliveries = rsvc.collect_pending_for_delivery(7)
    assert [d.action_id for d in deliveries] == [action_id]
    assert deliveries[0].action == "self_update"

    # Agent-side transitions via the existing service.
    assert rsvc.acknowledge(action_id).status == ActionStatus.ACKNOWLEDGED
    assert rsvc.mark_running(action_id).status == ActionStatus.RUNNING
    # self_update completes only after heartbeat verification; use a different
    # conflict group (remote_support restart) to prove ordinary terminal
    # completion on the same pipeline.
    restart = svc.execute(_device(db), "remote_support", "restart", created_by="mario")
    rsvc.collect_pending_for_delivery(7)
    done = rsvc.complete(restart.action.id, result_message="ok")
    assert done.status == ActionStatus.COMPLETED


def test_no_duplicate_via_existing_conflict_guard():
    db = _db()
    svc = ComponentActionService(db)
    svc.execute(_device(db), "agent", "restart", created_by="mario")
    try:
        svc.execute(_device(db), "agent", "restart", created_by="mario")
        assert False, "expected conflict"
    except ValueError:
        pass


# --------------------------------------------------------------------------- #
# Reverse attribution seam                                                     #
# --------------------------------------------------------------------------- #
def test_enriched_payload_merges_package_and_operator_params():
    db = _db()
    svc = ComponentActionService(db)
    resolved = svc.resolve_for_device(_device(db), "agent", "update")
    # Inject a fake package enrichment; operator params must win over it.
    svc._packages.enrichment_for = lambda cid, plat, op: {"version": "2.1.14", "target_sha256": "abc"}
    payload = svc._enriched_payload(_device(db), resolved)
    assert payload == {"version": "2.1.14", "target_sha256": "abc"}

    resolved2 = svc.resolve_for_device(_device(db), "agent", "update", parameters={"version": "9.9.9"})
    payload2 = svc._enriched_payload(_device(db), resolved2)
    assert payload2["version"] == "9.9.9"          # operator wins
    assert payload2["target_sha256"] == "abc"       # enrichment fills the gap


def test_attribute_maps_action_back_to_component_operation():
    assert ComponentActionService.attribute("self_update") == ("agent", "update")
    assert ComponentActionService.attribute("reinstall_rustdesk") == (
        "remote_support", "reinstall",
    )
    # A shared action folds to its first declared operation.
    assert ComponentActionService.attribute("deploy_remote_support") == (
        "remote_support", "install",
    )
    # Non-component actions and junk attribute to nothing.
    assert ComponentActionService.attribute("ping") is None
    assert ComponentActionService.attribute(None) is None
