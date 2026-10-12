"""Per-device Remote Support passwords: rotation without breaking Connect.

The agent applies a new password on the heartbeat that delivers it, so until
the device has checked in after a change, Connect must use the previous one.
"""
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.config import settings
from app.core.secret_cipher import decrypt_secret
from app.core.time import utcnow
from app.db.base import Base
from app.models.device import Device, DeviceStatus
from app.services.remote_support_password_service import RemoteSupportPasswordService

_ids = iter(range(100000000, 200000000))


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _device(db, *, agent_version="2.1.20", last_seen=None, **fields):
    values = dict(
        hostname="ws-01",
        rustdesk_id=str(next(_ids)),
        agent_version=agent_version,
        status=DeviceStatus.ONLINE,
        last_seen=(last_seen or utcnow()).replace(tzinfo=None),
    )
    values.update(fields)
    device = Device(**values)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def _heartbeat(db, device, at):
    device.last_seen = at.replace(tzinfo=None)
    db.commit()


def test_connect_keeps_the_old_password_until_the_agent_has_the_new_one(db):
    svc = RemoteSupportPasswordService(db)
    device = _device(db, last_seen=utcnow() - timedelta(minutes=1))
    old = svc.get_or_create(device)

    new = svc.rotate(device)
    assert new != old
    assert svc.for_connect(device) == old  # the agent has not checked in since

    _heartbeat(db, device, utcnow() + timedelta(seconds=1))
    assert svc.for_connect(device) == new
    assert device.remote_support_password_previous_ciphertext is None  # forgotten once delivered


def test_two_changes_before_delivery_keep_the_password_the_agent_holds(db):
    svc = RemoteSupportPasswordService(db)
    device = _device(db, last_seen=utcnow() - timedelta(minutes=1))
    held = svc.get_or_create(device)
    svc.rotate(device)
    svc.rotate(device)

    assert decrypt_secret(device.remote_support_password_previous_ciphertext) == held
    assert svc.for_connect(device) == held


def test_rotate_due_replaces_old_generated_passwords_only(db, monkeypatch):
    monkeypatch.setattr(settings, "REMOTE_SUPPORT_PASSWORD_ROTATION_DAYS", 30)
    svc = RemoteSupportPasswordService(db)
    old_age = (utcnow() - timedelta(days=31)).replace(tzinfo=None)

    due = _device(db)
    fresh = _device(db, hostname="fresh")
    custom = _device(db, hostname="custom")
    legacy = _device(db, hostname="legacy", agent_version="2.1.0")
    in_session = _device(db, hostname="busy", rustdesk_session_active=True)
    archived = _device(db, hostname="gone", is_archived=True)
    for device in (due, fresh, custom, legacy, in_session, archived):
        svc.get_or_create(device)
    svc.set_custom(custom, "Custom-Pass-123")
    for device in (due, custom, legacy, in_session, archived):
        device.remote_support_password_updated_at = old_age
    db.commit()
    before = {d.id: d.remote_support_password_ciphertext for d in (due, fresh, custom, legacy, in_session, archived)}

    assert svc.rotate_due() == 1

    changed = {d.id for d in (due, fresh, custom, legacy, in_session, archived)
               if d.remote_support_password_ciphertext != before[d.id]}
    assert changed == {due.id}


def test_rotation_can_be_switched_off(db, monkeypatch):
    monkeypatch.setattr(settings, "REMOTE_SUPPORT_PASSWORD_ROTATION_DAYS", 0)
    svc = RemoteSupportPasswordService(db)
    device = _device(db)
    svc.get_or_create(device)
    device.remote_support_password_updated_at = (utcnow() - timedelta(days=400)).replace(tzinfo=None)
    db.commit()

    assert svc.rotate_due() == 0


def test_rotate_all_covers_every_device_whose_agent_applies_it(db):
    svc = RemoteSupportPasswordService(db)
    current = _device(db)
    custom = _device(db, hostname="custom")
    legacy = _device(db, hostname="legacy", agent_version="2.0.0")
    svc.set_custom(custom, "Custom-Pass-123")

    assert svc.rotate_all() == 2
    assert custom.remote_support_password_source == "generated"
    assert current.remote_support_password_ciphertext is not None
    assert legacy.remote_support_password_ciphertext is None


def test_public_scripts_and_code_carry_no_shared_password():
    assert settings.RUSTDESK_DEFAULT_PASSWORD == ""
