"""Recent deployments read the real fleet command batches — never fixture rows."""
from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.time import utcnow
from app.db.base import Base
from app.models.agent_command_batch import AgentCommandBatch
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.device_group import DeviceGroup
from app.models.operator import Operator
from app.models.remote_action import ActionStatus, RemoteAction
from app.services.deployment_service import recent_deployments


TABLES = [
    Client.__table__,
    DeviceGroup.__table__,
    Operator.__table__,
    Device.__table__,
    AgentCommandBatch.__table__,
    RemoteAction.__table__,
]


def _db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine, tables=TABLES)
    return sessionmaker(bind=engine)()


def _batch(db, batch_id, statuses, *, command_type="self_update", minutes_ago=0, timeout=300):
    created = utcnow() - timedelta(minutes=minutes_ago)
    db.add(AgentCommandBatch(
        id=batch_id,
        command_type=command_type,
        payload="{}",
        target="all",
        timeout_seconds=timeout,
        created_at=created,
    ))
    for i, status in enumerate(statuses):
        device = Device(
            hostname=f"{batch_id}-{i}",
            agent_id=f"agent-{batch_id}-{i}",
            status=DeviceStatus.ONLINE,
            is_archived=False,
        )
        db.add(device)
        db.flush()
        db.add(RemoteAction(
            device_id=device.id,
            action_type=command_type,
            status=status,
            created_at=created,
            execution_timeout_seconds=timeout,
            batch_id=batch_id,
        ))
    db.commit()


def test_no_batches_means_no_deployments():
    assert recent_deployments(_db()) == []


def test_status_reflects_real_device_outcomes():
    db = _db()
    done, failed = ActionStatus.COMPLETED, ActionStatus.FAILED
    _batch(db, "all-ok", [done, done, done], minutes_ago=40)
    _batch(db, "partial", [done, done, failed], minutes_ago=30)
    _batch(db, "all-failed", [failed, failed], minutes_ago=20)
    _batch(db, "in-flight", [done, ActionStatus.RUNNING], minutes_ago=0)

    by_id = {d.id: d for d in recent_deployments(db, limit=10)}

    assert by_id["all-ok"].status == "success"
    assert by_id["partial"].status == "warning"
    assert (by_id["partial"].completed, by_id["partial"].failed, by_id["partial"].total) == (2, 1, 3)
    assert by_id["all-failed"].status == "failed"
    assert by_id["in-flight"].status == "running"


def test_devices_that_never_answered_count_against_the_deployment():
    db = _db()
    # Queued long past its timeout: the device never picked the command up.
    _batch(db, "stale", [ActionStatus.COMPLETED, ActionStatus.QUEUED], minutes_ago=60, timeout=30)

    [deployment] = recent_deployments(db)

    assert deployment.timeout == 1
    assert deployment.status == "warning"


def test_newest_first_and_limited():
    db = _db()
    for i in range(4):
        _batch(db, f"b{i}", [ActionStatus.COMPLETED], minutes_ago=10 * (4 - i))

    result = recent_deployments(db, limit=2)

    assert [d.id for d in result] == ["b3", "b2"]
