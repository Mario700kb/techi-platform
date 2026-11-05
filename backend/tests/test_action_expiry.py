"""Actions past their timeout expire even when nothing reads them: an agent
that died in the middle of a self-update must not leave its action "running"
for reports and counts that read the table directly."""
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow
from app.db.base import Base
from app.models.device import Device, DeviceStatus
from app.models.remote_action import ActionStatus, RemoteAction
from app.repositories.remote_action_repository import RemoteActionRepository


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(Device(id=1, hostname="pos1-qtu", agent_id="a1", platform="windows", status=DeviceStatus.ONLINE))
    session.commit()
    return session


def action(db, status, age_s, timeout_s=600):
    a = RemoteAction(device_id=1, action_type="self_update", status=status, execution_timeout_seconds=timeout_s,
                     created_at=utcnow() - timedelta(seconds=age_s))
    db.add(a)
    db.commit()
    return a


def test_overdue_open_actions_expire_and_the_rest_stay(db):
    stuck = action(db, ActionStatus.RUNNING, age_s=2700)        # 45 min, timeout 10
    queued = action(db, ActionStatus.QUEUED, age_s=900)
    fresh = action(db, ActionStatus.RUNNING, age_s=60)
    done = action(db, ActionStatus.COMPLETED, age_s=3600)

    assert RemoteActionRepository(db).expire_overdue() == 2
    for a in (stuck, queued, fresh, done):
        db.refresh(a)
    assert stuck.status == ActionStatus.EXPIRED and stuck.expired_at is not None
    assert queued.status == ActionStatus.EXPIRED
    assert fresh.status == ActionStatus.RUNNING
    assert done.status == ActionStatus.COMPLETED
    assert RemoteActionRepository(db).expire_overdue() == 0


def test_expiry_is_announced_to_live_consoles_with_the_reason(db, monkeypatch):
    """A console holds the last state it heard: without an event an update that
    ran out of time stayed on "Confirming the new version" until a reload."""
    from app.services import remote_action_service as svc

    published = []
    monkeypatch.setattr(svc, "_publish_action_status", lambda a, event: published.append((a.id, a.status, event.value)))

    swept = action(db, ActionStatus.RUNNING, age_s=2700)
    swept.stage = "confirming"
    db.commit()
    read = action(db, ActionStatus.RUNNING, age_s=2700)
    read.stage = "restarting"
    db.commit()

    repo = RemoteActionRepository(db)
    repo._expire_if_needed(read)
    repo.expire_overdue()

    assert sorted(published) == sorted([
        (read.id, ActionStatus.EXPIRED, "action_status_changed"),
        (swept.id, ActionStatus.EXPIRED, "action_status_changed"),
    ])
    assert "did not report the new version" in swept.error_message
    assert "did not come back" in read.error_message


def test_an_action_expired_before_any_progress_keeps_no_invented_reason(db):
    never_started = action(db, ActionStatus.SENT, age_s=2700)
    RemoteActionRepository(db).expire_overdue()
    db.refresh(never_started)
    assert never_started.status == ActionStatus.EXPIRED
    assert never_started.error_message is None


def test_a_self_update_without_a_timeout_outlasts_the_swap_watch(db):
    from app.schemas.remote_action import ActionType, RemoteActionCreate
    from app.services.remote_action_service import _execution_timeout

    def update(timeout):
        return RemoteActionCreate(action_type=ActionType.SELF_UPDATE, execution_timeout_seconds=timeout)

    assert _execution_timeout(update(None)) == 900
    assert _execution_timeout(update(120)) == 120  # a timeout the caller gives is kept
    assert _execution_timeout(RemoteActionCreate(action_type=ActionType.RESTART_AGENT)) == 300
