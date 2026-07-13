from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models.agent_command_batch import AgentCommandBatch
from app.models.device import Device
from app.models.remote_action import RemoteAction
from scripts.redact_remote_password_payloads import redact


def test_cleanup_is_dry_run_first_and_scoped_to_retired_command():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(
        bind=engine,
        tables=[Device.__table__, AgentCommandBatch.__table__, RemoteAction.__table__],
    )
    db = sessionmaker(bind=engine)()
    device = Device(hostname="cleanup-test", agent_id="cleanup-agent")
    db.add(device)
    db.flush()
    retired_batch = AgentCommandBatch(
        id="retired-batch",
        command_type="set_remote_password",
        payload='{"password":"sensitive"}',
        target="devices",
    )
    safe_batch = AgentCommandBatch(
        id="safe-batch", command_type="ping", payload='{"value":"keep"}', target="devices"
    )
    retired_action = RemoteAction(
        device_id=device.id,
        action_type="set_remote_password",
        payload='{"password":"sensitive"}',
    )
    safe_action = RemoteAction(device_id=device.id, action_type="ping", payload='{"value":"keep"}')
    db.add_all([retired_batch, safe_batch, retired_action, safe_action])
    db.commit()

    assert redact(db, execute=False) == (1, 1)
    assert retired_action.payload != "{}"
    assert retired_batch.payload != "{}"

    assert redact(db, execute=True) == (1, 1)
    db.refresh(retired_action)
    db.refresh(safe_action)
    db.refresh(retired_batch)
    db.refresh(safe_batch)
    assert retired_action.payload == "{}"
    assert retired_batch.payload == "{}"
    assert safe_action.payload == '{"value":"keep"}'
    assert safe_batch.payload == '{"value":"keep"}'
