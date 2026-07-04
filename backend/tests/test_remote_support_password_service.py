from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.secret_cipher import decrypt_secret, encrypt_secret
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.device_group import DeviceGroup
from app.services.remote_support_password_service import RemoteSupportPasswordService


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
    c = encrypt_secret("Durres.12")
    assert c.startswith("v1:")
    assert decrypt_secret(c) == "Durres.12"
    assert decrypt_secret("v1:" + "A" * 40) is None  # bad MAC
    assert decrypt_secret(None) is None
    assert decrypt_secret("plain") is None


def test_get_or_create_is_stable_and_encrypted_at_rest():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)

    pw1 = svc.get_or_create(device)
    assert len(pw1) == 16
    # stored encrypted, not plaintext
    assert device.remote_support_password_ciphertext
    assert pw1 not in device.remote_support_password_ciphertext
    assert device.remote_support_password_source == "generated"

    # idempotent: same value on subsequent reads
    assert svc.get_or_create(device) == pw1
    assert svc.get_plaintext(device) == pw1


def test_set_custom_and_regenerate():
    db = _db()
    device = _device(db)
    svc = RemoteSupportPasswordService(db)
    svc.get_or_create(device)

    svc.set_custom(device, "MyCustomPass1")
    assert svc.get_plaintext(device) == "MyCustomPass1"
    assert device.remote_support_password_source == "custom"

    new = svc.regenerate(device)
    assert new != "MyCustomPass1"
    assert device.remote_support_password_source == "generated"


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
    passwords = {svc.get_or_create(_device(db)) for _ in range(20)}
    assert len(passwords) == 20
