from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.v1.endpoints.remote_support import create_connect_launch_token
from app.api.v1.endpoints.remote_support_bridge import RedeemRequest, redeem_connect_token
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.operator import Operator
from app.models.remote_support_connect_token import RemoteSupportConnectToken
from app.services.remote_support_connect_service import (
    CONNECT_TOKEN_TTL_SECONDS,
    ConnectTokenError,
    RemoteSupportConnectService,
)
from app.services.remote_support_password_service import (
    RemoteSupportPasswordService,
    credential_fingerprint,
)


TABLES = [
    Operator.__table__,
    Client.__table__,
    Device.__table__,
    RemoteSupportConnectToken.__table__,
]


@pytest.fixture()
def session_factory(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'connect-token.db'}",
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    Base.metadata.create_all(bind=engine, tables=TABLES)
    return sessionmaker(bind=engine)


def _operator_and_device(db, *, client_id=1, apply=True):
    client = Client(id=client_id, name=f"Client {client_id}", slug=f"client-{client_id}")
    operator = Operator(
        username=f"op-{client_id}",
        email=f"op-{client_id}@test.invalid",
        hashed_password="x",
        role="operator",
        is_active=True,
    )
    device = Device(
        rustdesk_id=f"48664167{client_id}",
        hostname=f"device-{client_id}",
        status=DeviceStatus.ONLINE,
        client_id=client_id,
    )
    db.add_all([client, operator, device])
    db.commit()
    delivery = RemoteSupportPasswordService(db).ensure_desired(device)
    if apply:
        RemoteSupportPasswordService(db).process_ack(
            device,
            SimpleNamespace(
                generation=delivery.generation,
                status="applied",
                fingerprint=credential_fingerprint(
                    delivery.verification_key,
                    device_id=device.id,
                    generation=delivery.generation,
                    password=delivery.password,
                ),
                error=None,
            ),
        )
    return operator, device, delivery.password


def test_valid_token_creation_redemption_and_result(session_factory):
    db = session_factory()
    operator, device, password = _operator_and_device(db)
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)

    assert capability.connect_url.startswith("techiremotesupport://connect?token=")
    assert password not in capability.connect_url
    assert device.rustdesk_id not in capability.connect_url
    assert 40 <= (capability.expires_at - capability.expires_at.__class__.utcnow()).total_seconds() <= CONNECT_TOKEN_TTL_SECONDS
    row = db.query(RemoteSupportConnectToken).one()
    assert capability.token not in row.token_hash
    assert row.operator_id == operator.id
    assert row.client_id == device.client_id
    assert row.device_id == device.id

    redeemed = RemoteSupportConnectService(db).redeem(capability.token)
    assert redeemed.remote_id == device.rustdesk_id
    assert redeemed.password == password
    reported = RemoteSupportConnectService(db).report(
        receipt=redeemed.receipt,
        outcome="launched",
        failure_code=None,
    )
    assert reported.launch_result == "launched"


def test_token_is_single_use_and_receipt_is_single_use(session_factory):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)
    redeemed = RemoteSupportConnectService(db).redeem(capability.token)

    with pytest.raises(ConnectTokenError, match="invalid_or_expired_token"):
        RemoteSupportConnectService(db).redeem(capability.token)
    RemoteSupportConnectService(db).report(receipt=redeemed.receipt, outcome="failed", failure_code="client_missing")
    with pytest.raises(ConnectTokenError, match="invalid_receipt"):
        RemoteSupportConnectService(db).report(receipt=redeemed.receipt, outcome="failed", failure_code="client_missing")


def test_expired_token_is_rejected(session_factory):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)
    row = db.query(RemoteSupportConnectToken).one()
    row.expires_at = row.created_at - timedelta(seconds=1)
    db.commit()

    with pytest.raises(ConnectTokenError, match="invalid_or_expired_token"):
        RemoteSupportConnectService(db).redeem(capability.token)


def test_binding_change_is_consumed_and_rejected(session_factory):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)
    device.rustdesk_id = "999999999"
    db.commit()

    with pytest.raises(ConnectTokenError, match="launch_binding_changed"):
        RemoteSupportConnectService(db).redeem(capability.token)
    assert db.query(RemoteSupportConnectToken).one().consumed_at is not None


def test_operator_binding_change_is_consumed_and_rejected(session_factory):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)
    operator.is_active = False
    db.commit()

    with pytest.raises(ConnectTokenError, match="launch_binding_changed"):
        RemoteSupportConnectService(db).redeem(capability.token)


@pytest.mark.parametrize("status", ["pending", "failed"])
def test_missing_pending_or_failed_unconfirmed_credential_is_rejected(session_factory, status):
    db = session_factory()
    operator, device, _ = _operator_and_device(db, apply=False)
    device.remote_support_apply_status = status
    db.commit()

    with pytest.raises(ConnectTokenError, match="No confirmed applied"):
        RemoteSupportConnectService(db).create(operator=operator, device=device)


def test_pending_rotation_does_not_use_previous_active_credential(session_factory):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    RemoteSupportPasswordService(db).set_custom(device, "PendingReplacement12")
    assert RemoteSupportPasswordService(db).get_confirmed_active_plaintext(device)
    assert device.remote_support_apply_status == "pending"

    with pytest.raises(ConnectTokenError, match="No confirmed applied"):
        RemoteSupportConnectService(db).create(operator=operator, device=device)


@pytest.mark.parametrize(
    "changes",
    [
        {"status": DeviceStatus.OFFLINE},
        {"heartbeat_auth_state": "legacy_restricted"},
        {"remote_support_trusted_state": "unknown", "rustdesk_status": "unknown"},
    ],
)
def test_connect_is_independent_of_agent_and_runtime_telemetry(session_factory, changes):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    for name, value in changes.items():
        setattr(device, name, value)
    db.commit()
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)
    assert capability.device_id == device.id


def test_unassigned_tenant_is_rejected(session_factory):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    device.client_id = None
    db.commit()
    with pytest.raises(ConnectTokenError, match="assigned to a client"):
        RemoteSupportConnectService(db).create(operator=operator, device=device)


def test_concurrent_redemption_allows_exactly_one(session_factory):
    setup = session_factory()
    operator, device, _ = _operator_and_device(setup)
    capability = RemoteSupportConnectService(setup).create(operator=operator, device=device)
    setup.close()

    def redeem_once():
        db = session_factory()
        try:
            return RemoteSupportConnectService(db).redeem(capability.token).remote_id
        except (ConnectTokenError, Exception) as exc:
            return type(exc).__name__
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: redeem_once(), range(4)))
    assert results.count(device.rustdesk_id) == 1


def test_creation_audit_has_no_token_or_password(session_factory, monkeypatch):
    db = session_factory()
    operator, device, password = _operator_and_device(db)
    audits = []
    monkeypatch.setattr("app.api.v1.endpoints.remote_support._get_device", lambda *args, **kwargs: device)
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.audit_log",
        lambda *args, **kwargs: audits.append(kwargs),
    )

    response = create_connect_launch_token(
        request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
        db=db,
        operator=operator,
        scope=None,
        _perm=None,
        device_id=device.id,
    )
    serialized_audit = repr(audits)
    assert response.connect_url not in serialized_audit
    assert response.connect_url.split("token=", 1)[1] not in serialized_audit
    assert password not in serialized_audit
    assert audits[0]["details"]["credential_in_url"] is False


def test_redemption_audit_has_no_token_password_or_receipt(session_factory, monkeypatch):
    db = session_factory()
    operator, device, password = _operator_and_device(db)
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)
    audits = []
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support_bridge.system_audit_log",
        lambda *args, **kwargs: audits.append(kwargs),
    )
    result = redeem_connect_token(
        body=RedeemRequest(token=capability.token),
        request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.2")),
        response=Response(),
        db=db,
    )
    serialized_audit = repr(audits)
    assert capability.token not in serialized_audit
    assert result.receipt not in serialized_audit
    assert password not in serialized_audit
    assert result.password == password


def test_creation_rate_limit_returns_429_before_token_creation(session_factory, monkeypatch):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.remote_connect_create_limiter.is_allowed",
        lambda _key: False,
    )
    with pytest.raises(HTTPException) as exc:
        create_connect_launch_token(
            request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.3")),
            db=db,
            operator=operator,
            scope=None,
            _perm=None,
            device_id=device.id,
        )
    assert exc.value.status_code == 429
    assert db.query(RemoteSupportConnectToken).count() == 0


def test_redemption_rate_limit_returns_429_without_consuming_token(session_factory, monkeypatch):
    db = session_factory()
    operator, device, _ = _operator_and_device(db)
    capability = RemoteSupportConnectService(db).create(operator=operator, device=device)
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support_bridge.remote_connect_redeem_limiter.is_allowed",
        lambda _key: False,
    )
    with pytest.raises(HTTPException) as exc:
        redeem_connect_token(
            body=RedeemRequest(token=capability.token),
            request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.4")),
            response=Response(),
            db=db,
        )
    assert exc.value.status_code == 429
    assert db.query(RemoteSupportConnectToken).one().consumed_at is None
