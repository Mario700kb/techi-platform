import json
from types import SimpleNamespace

import pytest
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
from app.services import agent_command_service as agent_command_service_module
from app.services.agent_command_service import AgentCommandService
from app.services.remote_action_service import RemoteActionService


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
            command_type="ping",
            payload={},
            target=BulkCommandTarget.ONLINE,
            timeout_seconds=30,
        ),
        operator_username="admin",
    )

    actions = db.query(RemoteAction).filter(RemoteAction.batch_id == result.batch_id).all()
    hostnames = sorted(action.device.hostname for action in actions)
    assert hostnames == ["online-one", "online-two"]
    assert {action.execution_timeout_seconds for action in actions} == {30}

    batch = db.get(AgentCommandBatch, result.batch_id)
    assert batch.timeout_seconds == 30


def test_set_remote_password_command_is_rejected_without_persistence():
    db = next(_db())
    db.add(_device("online-one", DeviceStatus.ONLINE))
    db.commit()

    retired = BulkCommandCreate.model_construct(
        command_type="set_remote_password",
        payload={"password": "must-not-persist"},
        target=BulkCommandTarget.ONLINE,
        timeout_seconds=300,
    )
    with pytest.raises(ValueError, match="is disabled"):
        AgentCommandService(db).create_bulk(retired)

    assert db.query(AgentCommandBatch).count() == 0
    assert db.query(RemoteAction).count() == 0


def test_historical_password_action_is_not_delivered():
    db = next(_db())
    device = _device("online-one", DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    db.refresh(device)
    historical = RemoteAction(
        device_id=device.id,
        action_type="set_remote_password",
        payload=json.dumps({"password": "historical-sensitive-value"}),
        status=ActionStatus.QUEUED,
        queued_at=agent_command_service_module.utcnow(),
    )
    db.add(historical)
    db.commit()

    assert RemoteActionService(db).collect_pending_for_delivery(device.id) == []
    db.refresh(historical)
    assert historical.status == ActionStatus.FAILED
    assert historical.error_message == "retired credential command blocked before delivery"


def test_outdated_agents_target_queues_only_agent_binary_mismatches(monkeypatch):
    db = next(_db())
    active_sha = "a" * 64
    current = _device("current-agent", DeviceStatus.ONLINE)
    stale_hash = _device("stale-hash-agent", DeviceStatus.ONLINE)
    missing_hash = _device("missing-hash-agent", DeviceStatus.ONLINE)
    legacy = _device("legacy-msi-agent", DeviceStatus.ONLINE)
    current.agent_version = "2.1.1"
    current.agent_sha256 = active_sha
    stale_hash.agent_version = "2.1.1"
    stale_hash.agent_sha256 = "b" * 64
    missing_hash.agent_version = "2.1.1"
    missing_hash.agent_sha256 = None
    legacy.agent_version = "2.1.0"
    legacy.agent_sha256 = None
    db.add_all([current, stale_hash, missing_hash, legacy])
    db.commit()

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            if file_type == "agent_binary":
                return SimpleNamespace(version="2.1.1", sha256=active_sha)
            if file_type == "agent_update_msi":
                return SimpleNamespace(version="2.1.1", sha256="c" * 64)
            raise AssertionError(f"unexpected file_type={file_type}")

        def agent_update_msi_download_url(self):
            return "/api/v1/agent-packages/agent-update-msi/download"

        def agent_binary_download_url(self):
            return "/api/v1/agent-packages/agent-binary/download"

    monkeypatch.setattr(agent_command_service_module, "AgentPackageService", FakeAgentPackageService)

    result = AgentCommandService(db).create_bulk(
        BulkCommandCreate(
            command_type="self_update",
            payload={},
            target=BulkCommandTarget.OUTDATED_AGENTS,
            timeout_seconds=30,
        ),
        operator_username="admin",
    )

    actions = db.query(RemoteAction).filter(RemoteAction.batch_id == result.batch_id).all()
    actions_by_hostname = {action.device.hostname: action for action in actions}
    assert sorted(actions_by_hostname) == ["legacy-msi-agent", "missing-hash-agent", "stale-hash-agent"]
    assert {action.execution_timeout_seconds for action in actions} == {900}

    legacy_payload = json.loads(actions_by_hostname["legacy-msi-agent"].payload)
    assert legacy_payload["package_type"] == "msi"
    assert legacy_payload["sha256"] == "c" * 64
    assert legacy_payload["target_sha256"] == active_sha
    assert legacy_payload["download_url"].endswith("/agent-update-msi/download")

    # 2.1.1 agents use the binary-swap flow even when they never reported a
    # SHA — sending them an MSI would make them swap the exe with MSI bytes.
    for hostname in ("missing-hash-agent", "stale-hash-agent"):
        binary_payload = json.loads(actions_by_hostname[hostname].payload)
        assert "package_type" not in binary_payload
        assert binary_payload["sha256"] == active_sha
        assert binary_payload["download_url"].endswith("/agent-binary/download")


def test_self_update_refuses_legacy_agents_without_matching_active_msi(monkeypatch):
    db = next(_db())
    legacy = _device("legacy-agent", DeviceStatus.ONLINE)
    legacy.agent_version = "2.1.0"
    legacy.agent_sha256 = None
    db.add(legacy)
    db.commit()

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            if file_type == "agent_binary":
                return SimpleNamespace(version="2.1.1", sha256="a" * 64)
            if file_type == "agent_update_msi":
                return SimpleNamespace(version="2.1.0", sha256="b" * 64)
            raise AssertionError(f"unexpected file_type={file_type}")

        def agent_binary_download_url(self):
            return "/api/v1/agent-packages/agent-binary/download"

    monkeypatch.setattr(agent_command_service_module, "AgentPackageService", FakeAgentPackageService)

    try:
        AgentCommandService(db).create_bulk(
            BulkCommandCreate(
                command_type="self_update",
                payload={},
                target=BulkCommandTarget.DEVICES,
                device_ids=[legacy.id],
                timeout_seconds=30,
            ),
            operator_username="admin",
        )
    except ValueError as exc:
        assert "Legacy agents (version < 2.1.1) require an active Agent Update Bridge MSI (file_type=agent_update_msi) for version 2.1.1" in str(exc)
        assert "legacy-agent" in str(exc)
    else:
        raise AssertionError("expected ValueError for legacy self_update without matching MSI")

    assert db.query(AgentCommandBatch).count() == 0
    assert db.query(RemoteAction).count() == 0


def test_self_update_sends_binary_payload_to_211_agent_without_sha(monkeypatch):
    """Regression: 2.1.1 fleet builds that predate SHA reporting run the
    binary-swap flow. They must get the EXE payload — not the MSI — even when
    the active MSI version differs from the active agent binary."""
    db = next(_db())
    device = _device("no-sha-211-agent", DeviceStatus.ONLINE)
    device.agent_version = "2.1.1"
    device.agent_sha256 = None
    db.add(device)
    db.commit()
    db.refresh(device)

    active_sha = "a" * 64

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            if file_type == "agent_binary":
                return SimpleNamespace(version="2.1.1", sha256=active_sha)
            if file_type == "agent_update_msi":
                # Mismatched MSI must not matter for binary-swap agents.
                return SimpleNamespace(version="2.1.0", sha256="b" * 64)
            raise AssertionError(f"unexpected file_type={file_type}")

        def agent_binary_download_url(self):
            return "/api/v1/agent-packages/agent-binary/download"

    monkeypatch.setattr(agent_command_service_module, "AgentPackageService", FakeAgentPackageService)

    result = AgentCommandService(db).create_bulk(
        BulkCommandCreate(
            command_type="self_update",
            payload={},
            target=BulkCommandTarget.DEVICES,
            device_ids=[device.id],
            timeout_seconds=30,
        ),
        operator_username="admin",
    )

    action = db.query(RemoteAction).filter(RemoteAction.batch_id == result.batch_id).one()
    payload = json.loads(action.payload)
    assert "package_type" not in payload
    assert payload["sha256"] == active_sha
    assert payload["download_url"].endswith("/agent-binary/download")


def test_self_update_complete_uses_target_sha256_for_legacy_msi_payload():
    db = next(_db())
    target_sha = "a" * 64
    msi_sha = "b" * 64
    device = _device("legacy-verify-agent", DeviceStatus.ONLINE)
    device.agent_version = "2.1.1"
    device.agent_sha256 = target_sha
    db.add(device)
    db.commit()
    db.refresh(device)

    action = RemoteAction(
        device_id=device.id,
        action_type="self_update",
        payload=json.dumps({"version": "2.1.1", "sha256": msi_sha, "target_sha256": target_sha}),
        status=ActionStatus.RUNNING,
        execution_timeout_seconds=900,
    )
    db.add(action)
    db.commit()
    db.refresh(action)

    RemoteActionService(db).verify_self_update_for_device(device.id)
    db.refresh(action)

    assert action.status == ActionStatus.COMPLETED
    assert target_sha[:12] in action.result_message


def test_self_update_complete_waits_when_legacy_msi_target_sha_does_not_match():
    db = next(_db())
    target_sha = "a" * 64
    device = _device("legacy-wait-agent", DeviceStatus.ONLINE)
    device.agent_version = "2.1.1"
    device.agent_sha256 = "b" * 64
    db.add(device)
    db.commit()
    db.refresh(device)

    action = RemoteAction(
        device_id=device.id,
        action_type="self_update",
        payload=json.dumps({"version": "2.1.1", "sha256": "c" * 64, "target_sha256": target_sha}),
        status=ActionStatus.RUNNING,
        execution_timeout_seconds=900,
    )
    db.add(action)
    db.commit()
    db.refresh(action)

    RemoteActionService(db).verify_self_update_for_device(device.id)
    db.refresh(action)

    assert action.status == ActionStatus.RUNNING


def test_self_update_complete_waits_for_heartbeat_sha_verification():
    db = next(_db())
    target_sha = "a" * 64
    device = _device("verify-agent", DeviceStatus.ONLINE)
    device.agent_version = "2.1.0"
    device.agent_sha256 = None
    db.add(device)
    db.commit()
    db.refresh(device)

    action = RemoteAction(
        device_id=device.id,
        action_type="self_update",
        payload=json.dumps({"version": "2.1.1", "sha256": target_sha}),
        status=ActionStatus.RUNNING,
        execution_timeout_seconds=900,
    )
    db.add(action)
    db.commit()
    db.refresh(action)

    service = RemoteActionService(db)
    updated = service.complete(action.id, result_message="Self-update to v2.1.1 initiated in background")

    assert updated.status == ActionStatus.RUNNING
    assert updated.completed_at is None
    assert updated.result_message == "Self-update initiated; awaiting heartbeat verification"

    device.agent_version = "2.1.1"
    device.agent_sha256 = target_sha
    db.add(device)
    db.commit()

    service.verify_self_update_for_device(device.id)
    db.refresh(updated)

    assert updated.status == ActionStatus.COMPLETED
    assert "verified by heartbeat" in updated.result_message


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


def test_online_bulk_target_with_no_online_devices_does_not_create_empty_batch():
    db = next(_db())
    db.add(_device("offline-one", DeviceStatus.OFFLINE))
    db.commit()

    service = AgentCommandService(db)
    try:
        service.create_bulk(
            BulkCommandCreate(
                command_type="ping",
                payload={},
                target=BulkCommandTarget.ONLINE,
                timeout_seconds=300,
            )
        )
    except ValueError as exc:
        assert str(exc) == "No active devices found for the specified target"
    else:
        raise AssertionError("expected ValueError for empty online target")

    assert db.query(AgentCommandBatch).count() == 0
    assert db.query(RemoteAction).count() == 0


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
