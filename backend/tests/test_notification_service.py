"""Notification Engine — NotificationService core: flag gate, severity
filter, cooldown, rate limit, send success/failure, retry scheduling."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.vault_cipher as vault_cipher
from app.core.config import settings
from app.db.base import Base
from app.models.notification import (
    NotificationChannel,
    NotificationDelivery,
    NotificationDeliveryStatus,
    NotificationRule,
)
from app.services import notification_channels as channels_module
from app.services.notification_service import MAX_ATTEMPTS, NotificationService


@pytest.fixture(autouse=True)
def _isolated_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(
        bind=engine,
        tables=[NotificationChannel.__table__, NotificationRule.__table__, NotificationDelivery.__table__],
    )
    return sessionmaker(bind=engine)()


def _make_channel(db, channel_type="webhook", config=None, secret=None, enabled=True):
    ciphertext, dek = (None, None)
    if secret:
        ciphertext, dek = NotificationService.encrypt_secret_for_storage(secret)
    channel = NotificationChannel(
        name="test-channel",
        channel_type=channel_type,
        enabled=enabled,
        config_json=NotificationService.encode_config(config or {"url": "https://example.com/hook"}),
        secret_ciphertext=ciphertext,
        secret_dek_wrapped=dek,
    )
    db.add(channel)
    db.commit()
    db.refresh(channel)
    return channel


def _make_rule(db, channel, event_type="device_offline", **kwargs):
    kwargs.setdefault("scope_type", "global")
    rule = NotificationRule(event_type=event_type, channel_id=channel.id, **kwargs)
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


def test_dispatch_noop_when_flag_off(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", False)
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel)
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m")
    assert db.query(NotificationDelivery).count() == 0


def test_dispatch_noop_when_no_matching_rule(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    db = _db()
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m")
    assert db.query(NotificationDelivery).count() == 0


def test_dispatch_sends_and_marks_sent(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(channels_module, "CHANNEL_SENDERS", {"webhook": channels_module.CHANNEL_SENDERS["webhook"]})
    monkeypatch.setattr(
        channels_module.WebhookSender, "send",
        lambda self, **kwargs: (True, None),
    )
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel)
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m", severity="critical")
    deliveries = db.query(NotificationDelivery).all()
    assert len(deliveries) == 1
    assert deliveries[0].status == NotificationDeliveryStatus.SENT.value
    assert deliveries[0].sent_at is not None


def test_dispatch_schedules_retry_on_failure(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(
        channels_module.WebhookSender, "send",
        lambda self, **kwargs: (False, "connection refused"),
    )
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel)
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m")
    delivery = db.query(NotificationDelivery).one()
    assert delivery.status == NotificationDeliveryStatus.RETRYING.value
    assert delivery.next_retry_at is not None
    assert delivery.attempt_count == 1
    assert delivery.last_error == "connection refused"


def test_retry_delivery_marks_failed_after_max_attempts(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (False, "still down"))
    db = _db()
    channel = _make_channel(db)
    rule = _make_rule(db, channel)
    svc = NotificationService(db)
    svc.dispatch(event_type="device_offline", title="t", message="m")
    delivery = db.query(NotificationDelivery).one()
    for _ in range(MAX_ATTEMPTS - 1):
        svc.retry_delivery(delivery)
    assert delivery.status == NotificationDeliveryStatus.FAILED.value
    assert delivery.attempt_count == MAX_ATTEMPTS


def test_severity_filter_blocks_below_threshold(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel, min_severity="critical")
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m", severity="warning")
    assert db.query(NotificationDelivery).count() == 0
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m", severity="critical")
    assert db.query(NotificationDelivery).count() == 1


def test_cooldown_suppresses_repeat_within_window(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel, cooldown_seconds=3600)
    svc = NotificationService(db)
    svc.dispatch(event_type="device_offline", title="t", message="m")
    svc.dispatch(event_type="device_offline", title="t", message="m")
    assert db.query(NotificationDelivery).count() == 1


def test_rate_limit_suppresses_after_threshold(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel, rate_limit_per_hour=2)
    svc = NotificationService(db)
    for _ in range(3):
        svc.dispatch(event_type="device_offline", title="t", message="m")
    assert db.query(NotificationDelivery).count() == 2


def test_disabled_rule_does_not_fire(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel, enabled=False)
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m")
    assert db.query(NotificationDelivery).count() == 0


def test_disabled_channel_does_not_fire(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    db = _db()
    channel = _make_channel(db, enabled=False)
    _make_rule(db, channel)
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m")
    assert db.query(NotificationDelivery).count() == 0


def test_client_scoped_rule_only_matches_its_client(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel, scope_type="client", client_id=42)
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m", client_id=7)
    assert db.query(NotificationDelivery).count() == 0
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m", client_id=42)
    assert db.query(NotificationDelivery).count() == 1


def test_global_rule_matches_any_client(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel, scope_type="global")
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m", client_id=99)
    assert db.query(NotificationDelivery).count() == 1


def test_dispatch_never_raises_on_internal_error(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)

    def _boom(self, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(channels_module.WebhookSender, "send", _boom)
    db = _db()
    channel = _make_channel(db)
    _make_rule(db, channel)
    # Must not raise — same best-effort contract as audit_log.
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m")


def test_send_test_records_delivery_without_rule(monkeypatch):
    monkeypatch.setattr(channels_module.WebhookSender, "send", lambda self, **kwargs: (True, None))
    db = _db()
    channel = _make_channel(db)
    svc = NotificationService(db)
    ok, error = svc.send_test(channel, "hello")
    assert ok is True
    assert error is None
    delivery = db.query(NotificationDelivery).one()
    assert delivery.rule_id is None
    assert delivery.event_type == "test"
    assert delivery.status == NotificationDeliveryStatus.SENT.value


def test_channel_secret_round_trips_through_encryption(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_NOTIFICATIONS", True)
    captured = {}

    def _capture(self, *, config, secret, **kwargs):
        captured["secret"] = secret
        return True, None

    monkeypatch.setattr(channels_module.WebhookSender, "send", _capture)
    db = _db()
    channel = _make_channel(db, secret="super-secret-value")
    _make_rule(db, channel)
    NotificationService(db).dispatch(event_type="device_offline", title="t", message="m")
    assert captured["secret"] == "super-secret-value"
