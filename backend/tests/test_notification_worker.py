"""Notification retry worker — picks up RETRYING deliveries past
next_retry_at, re-attempts via the same send path as dispatch()."""

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.vault_cipher as vault_cipher
from app.core.config import settings
from app.core.time import utcnow
from app.db.base import Base
from app.models.notification import (
    NotificationChannel,
    NotificationDelivery,
    NotificationDeliveryStatus,
    NotificationRule,
)
from app.services import notification_channels as channels_module
from app.services.notification_service import NotificationService
from app.workers import notification_worker as worker_module
from app.workers.notification_worker import NotificationWorker


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(
        bind=engine,
        tables=[NotificationChannel.__table__, NotificationRule.__table__, NotificationDelivery.__table__],
    )
    return sessionmaker(bind=engine)


def _seed_channel(session_factory):
    db = session_factory()
    channel = NotificationChannel(
        name="c", channel_type="webhook", enabled=True,
        config_json=NotificationService.encode_config({"url": "https://x"}),
    )
    db.add(channel)
    db.commit()
    db.refresh(channel)
    channel_id = channel.id
    db.close()
    return channel_id


def _seed_delivery(session_factory, channel_id, *, next_retry_delta):
    db = session_factory()
    delivery = NotificationDelivery(
        rule_id=None, channel_id=channel_id, event_type="device_offline",
        title="t", message="m", status=NotificationDeliveryStatus.RETRYING.value,
        attempt_count=1, next_retry_at=utcnow() + next_retry_delta,
    )
    db.add(delivery)
    db.commit()
    db.refresh(delivery)
    delivery_id = delivery.id
    db.close()
    return delivery_id


def test_run_once_retries_due_deliveries_and_marks_sent(monkeypatch):
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    session_factory = _session_factory()
    monkeypatch.setattr(worker_module, "SessionLocal", session_factory)

    channel_id = _seed_channel(session_factory)
    delivery_id = _seed_delivery(session_factory, channel_id, next_retry_delta=timedelta(seconds=-1))

    async def _run():
        wd = NotificationWorker()
        return await wd.run_once()

    attempted = asyncio.run(_run())
    assert attempted == 1

    check_db = session_factory()
    delivery = check_db.get(NotificationDelivery, delivery_id)
    assert delivery.status == NotificationDeliveryStatus.SENT.value


def test_run_once_ignores_deliveries_not_yet_due(monkeypatch):
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    session_factory = _session_factory()
    monkeypatch.setattr(worker_module, "SessionLocal", session_factory)

    channel_id = _seed_channel(session_factory)
    _seed_delivery(session_factory, channel_id, next_retry_delta=timedelta(minutes=30))

    async def _run():
        wd = NotificationWorker()
        return await wd.run_once()

    assert asyncio.run(_run()) == 0


def test_run_once_is_a_noop_with_nothing_pending(monkeypatch):
    session_factory = _session_factory()
    monkeypatch.setattr(worker_module, "SessionLocal", session_factory)

    async def _run():
        wd = NotificationWorker()
        return await wd.run_once()

    assert asyncio.run(_run()) == 0


def test_start_stop_lifecycle_does_not_raise(monkeypatch):
    session_factory = _session_factory()
    monkeypatch.setattr(worker_module, "SessionLocal", session_factory)

    async def _body():
        wd = NotificationWorker()
        wd.start()
        assert wd._task is not None and not wd._task.done()
        await wd.stop()
        assert wd._task.cancelled() or wd._task.done()

    asyncio.run(_body())
