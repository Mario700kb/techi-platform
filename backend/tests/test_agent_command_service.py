from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models.agent_command_batch import AgentCommandBatch
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.device_group import DeviceGroup
from app.models.remote_action import ActionStatus, RemoteAction
from app.schemas.agent_command import BulkCommandCreate, BulkCommandTarget
from app.services.agent_command_service import AgentCommandService


TABLES = [
    Client.__table__,
    DeviceGroup.__table__,
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
    session_local = sessionmaker(bind=engine)
    session = session_local()
    try:
        yield session
    finally:
        session.close()


def _device(hostname: str, status: DeviceStatus) -> Device:
    return Device(
        hostname=hostname,
        agent_id=f"agent-{hostname}",
        status=status,
        is_archived=False,
    )


def test_online_bulk_target_queues_only_online_devices():
    db = next(_db())
    db.add_all([
        _device("online-one", DeviceStatus.ONLINE),
        _device("online-two", DeviceStatus.ONLINE),
        _device("offline-one", DeviceStatus.OFFLINE),
    ])
    db.commit()

    result = AgentCommandService(db).create_bulk(
        BulkCommandCreate(
            command_type="set_remote_password",
            payload={"password": "secret"},
            target=BulkCommandTarget.ONLINE,
            timeout_seconds=30,
        ),
        operator_username="admin",
    )

    actions = db.query(RemoteAction).filter(RemoteAction.batch_id == result.batch_id).all()
    hostnames = sorted(action.device.hostname for action in actions)
    assert hostnames == ["online-one", "online-two"]
    assert {action.execution_timeout_seconds for action in actions} == {300}

    batch = db.get(AgentCommandBatch, result.batch_id)
    assert batch.timeout_seconds == 300


def test_empty_batch_progress_is_finished():
    db = next(_db())
    batch = AgentCommandBatch(
        id="empty-batch",
        command_type="set_remote_password",
        payload="{}",
        target="all",
        timeout_seconds=300,
    )
    db.add(batch)
    db.commit()

    progress = AgentCommandService(db).get_batch_progress("empty-batch")

    assert progress.total == 0
    assert progress.percent == 100
    assert progress.finished is True


def test_batch_history_marks_empty_batch_finished():
    db = next(_db())
    batch = AgentCommandBatch(
        id="empty-history",
        command_type="set_remote_password",
        payload="{}",
        target="all",
        timeout_seconds=300,
    )
    db.add(batch)
    db.commit()

    history = AgentCommandService(db).get_history()

    assert history[0].batch_id == "empty-history"
    assert history[0].finished is True


def test_completed_batch_still_finishes_normally():
    db = next(_db())
    device = _device("online-one", DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    db.refresh(device)
    batch = AgentCommandBatch(
        id="completed-batch",
        command_type="ping",
        payload="{}",
        target="devices",
        timeout_seconds=30,
    )
    db.add(batch)
    db.add(RemoteAction(
        device_id=device.id,
        action_type="ping",
        payload="{}",
        status=ActionStatus.COMPLETED,
        batch_id=batch.id,
    ))
    db.commit()

    progress = AgentCommandService(db).get_batch_progress("completed-batch")

    assert progress.total == 1
    assert progress.completed == 1
    assert progress.percent == 100
    assert progress.finished is True
