from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.secret_cipher import decrypt_secret, encrypt_secret
from app.core.config import settings
from app.core.vault_cipher import reset_master_key_cache_for_tests
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.device_group import DeviceGroup
from app.services.remote_support_password_service import (
    RemoteSupportPasswordService,
    credential_fingerprint,
)
from types import SimpleNamespace
import pytest


@pytest.fixture(autouse=True)
def _vault_key(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault.key"))
    reset_master_key_cache_for_tests()
    yield
    reset_master_key_cache_for_tests()


def _db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        bind=engine,
        tables=[Client.__table__, DeviceGroup.__table__, Device.__table__],
    )
    return sessionmaker(bind=engine)()


_counter = 0


def _device(db):
    global _counter
    _counter += 1
    d = Device(hostname=f"h{_counter}", agent_id=f"a{_counter}", status=DeviceStatus.ONLINE)
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def test_cipher_roundtrip_and_tamper():
    c = encrypt_secret("LegacyUnique9")
    assert c.startswith("v1:")
    assert decrypt_secret(c) == "LegacyUnique9"
    assert decrypt_secret("v1:" + "A" * 40) is None  # bad MAC
    assert decrypt_secret(None) is None
    assert decrypt_secret("plain") is None


def test_ensure_desired_is_stable_pending_and_encrypted_at_rest():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)

    pw1 = svc.ensure_desired(device).password
    assert len(pw1) == 16
    # stored encrypted, not plaintext
    assert device.remote_support_desired_password_ciphertext.startswith("vgcm1:")
    assert device.remote_support_desired_password_wrapped_dek.startswith("vgcm1:")
    assert pw1 not in device.remote_support_desired_password_ciphertext
    assert device.remote_support_desired_source == "generated"
    assert device.remote_support_apply_status == "pending"
    assert device.remote_support_password_ciphertext is None

    # idempotent: same value on subsequent reads
    assert svc.ensure_desired(device).password == pw1
    assert svc.pending_delivery(device).password == pw1


def test_set_custom_and_regenerate():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)
    svc.ensure_desired(device)

    svc.set_custom(device, "MyCustomPass1")
    assert svc.pending_delivery(device).password == "MyCustomPass1"
    assert device.remote_support_desired_source == "custom"

    new = svc.regenerate(device)
    assert new != "MyCustomPass1"
    assert device.remote_support_desired_source == "generated"


def test_set_custom_rejects_too_short():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)
    try:
        svc.set_custom(device, "short")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for short password")


def test_generated_passwords_are_unique_per_device():
    db = _db()
    svc = RemoteSupportPasswordService(db)
    passwords = {svc.ensure_desired(_device(db)).password for _ in range(20)}
    assert len(passwords) == 20


def _applied_ack(device, delivery):
    return SimpleNamespace(
        generation=delivery.generation,
        status="applied",
        fingerprint=credential_fingerprint(
            delivery.verification_key,
            device_id=device.id,
            generation=delivery.generation,
            password=delivery.password,
        ),
        error=None,
    )


def test_matching_ack_promotes_desired_to_active():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)
    delivery = svc.ensure_desired(device)

    assert svc.process_ack(device, _applied_ack(device, delivery)) is True

    assert svc.get_active_plaintext(device) == delivery.password
    assert device.remote_support_active_generation == delivery.generation
    assert device.remote_support_applied_generation == delivery.generation
    assert device.remote_support_apply_status == "applied"
    assert device.remote_support_verification_key_ciphertext is None


def test_failed_rotation_retains_previous_active_credential():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)
    first = svc.ensure_desired(device)
    svc.process_ack(device, _applied_ack(device, first))
    active_before = svc.get_active_plaintext(device)
    second_password = svc.set_custom(device, "DifferentPass99")
    second_generation = device.remote_support_desired_generation

    svc.process_ack(
        device,
        SimpleNamespace(
            generation=second_generation,
            status="failed",
            fingerprint=None,
            error="runtime rejected credential\nsecret=not-logged",
        ),
    )

    assert second_password != active_before
    assert svc.get_active_plaintext(device) == active_before
    assert device.remote_support_active_generation == first.generation
    assert device.remote_support_apply_status == "failed"
    assert "\n" not in device.remote_support_failure_reason


def test_stale_ack_is_ignored():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)
    first = svc.ensure_desired(device)
    svc.regenerate(device)

    assert svc.process_ack(device, _applied_ack(device, first)) is False
    assert device.remote_support_apply_status == "pending"
    assert device.remote_support_password_ciphertext is None


def test_legacy_ciphertext_migrates_to_vault_on_read():
    db = _db()
    device = _device(db)
    device.remote_support_password_ciphertext = encrypt_secret("LegacyUniquePass")
    device.remote_support_password_source = "generated"
    db.add(device)
    db.commit()
    svc = RemoteSupportPasswordService(db)

    assert svc.get_active_plaintext(device) == "LegacyUniquePass"
    assert device.remote_support_password_ciphertext.startswith("vgcm1:")
    assert device.remote_support_password_wrapped_dek.startswith("vgcm1:")
