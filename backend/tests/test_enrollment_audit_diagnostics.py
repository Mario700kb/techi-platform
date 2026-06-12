from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints.enrollment_tokens import router as enrollment_tokens_router
from app.core.auth import get_current_operator
from app.db.base import Base
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.enrollment_audit import EnrollmentAudit
from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus
from app.models.operator import Operator
from app.schemas.agent import AgentEnrollmentRequest
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.enrollment_audit_service import EnrollmentAuditService
from app.services.enrollment_token_service import EnrollmentTokenService


TABLES = [
    Client.__table__,
    DeviceGroup.__table__,
    EnrollmentToken.__table__,
    Device.__table__,
    EnrollmentAudit.__table__,
]


def _db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine, tables=TABLES)
    return sessionmaker(bind=engine)()


def _token(db, *, name="Audit token", use_count=0, client_id=None, group_id=None):
    plaintext = "audit-token-value-1234567890"
    token = EnrollmentToken(
        name=name,
        token_hash=EnrollmentTokenService.hash_token(plaintext),
        token_prefix=plaintext[:8],
        status=EnrollmentTokenStatus.ACTIVE,
        max_uses=50,
        use_count=use_count,
        client_id=client_id,
        group_id=group_id,
    )
    db.add(token)
    db.commit()
    db.refresh(token)
    return token, plaintext


def _payload(token):
    return AgentEnrollmentRequest(
        enrollment_token=token,
        hostname="GFFA-PC-01",
        current_user="gffa-user",
        domain="GFFA",
        local_ip="10.0.0.10",
        public_ip="198.51.100.10",
        rustdesk_id="123456789",
        platform="windows",
        os_name="Windows 11",
    )


def test_audit_event_written_for_successful_enrollment():
    db = _db()
    token, plaintext = _token(db)

    response = AgentEnrollmentService(db).enroll(
        _payload(plaintext),
        heartbeat_url="https://example.test/heartbeat",
        websocket_url="wss://example.test/ws",
    )

    event = db.query(EnrollmentAudit).one()
    assert response.device_id == event.device_id
    assert event.token_id == token.id
    assert event.result == "success"
    assert event.hostname == "GFFA-PC-01"
    assert db.get(EnrollmentToken, token.id).use_count == 1


def test_reenrollment_does_not_increment_use_count():
    db = _db()
    token, plaintext = _token(db)
    service = AgentEnrollmentService(db)

    first = service.enroll(
        _payload(plaintext),
        heartbeat_url="https://example.test/heartbeat",
        websocket_url="wss://example.test/ws",
    )
    assert db.get(EnrollmentToken, token.id).use_count == 1

    second = service.enroll(
        _payload(plaintext),
        heartbeat_url="https://example.test/heartbeat",
        websocket_url="wss://example.test/ws",
    )

    assert second.device_id == first.device_id
    assert db.get(EnrollmentToken, token.id).use_count == 1
    reenroll_event = (
        db.query(EnrollmentAudit)
        .filter(EnrollmentAudit.result == "updated_existing")
        .one()
    )
    assert reenroll_event.reason == "reenrollment_match"


def test_exhausted_token_still_allows_reenrollment_of_existing_device():
    db = _db()
    token, plaintext = _token(db)
    service = AgentEnrollmentService(db)

    first = service.enroll(
        _payload(plaintext),
        heartbeat_url="https://example.test/heartbeat",
        websocket_url="wss://example.test/ws",
    )

    token.use_count = token.max_uses
    token.status = EnrollmentTokenStatus.USED
    db.commit()

    second = service.enroll(
        _payload(plaintext),
        heartbeat_url="https://example.test/heartbeat",
        websocket_url="wss://example.test/ws",
    )

    refreshed = db.get(EnrollmentToken, token.id)
    assert second.device_id == first.device_id
    assert refreshed.use_count == refreshed.max_uses
    assert refreshed.status == EnrollmentTokenStatus.USED


def test_exhausted_token_rejects_new_device():
    db = _db()
    token, plaintext = _token(db)
    token.use_count = token.max_uses
    token.status = EnrollmentTokenStatus.USED
    db.commit()

    payload = AgentEnrollmentRequest(
        enrollment_token=plaintext,
        hostname="BRAND-NEW-PC",
        local_ip="10.0.0.99",
        public_ip="198.51.100.99",
        platform="windows",
    )

    try:
        AgentEnrollmentService(db).enroll(
            payload,
            heartbeat_url="https://example.test/heartbeat",
            websocket_url="wss://example.test/ws",
        )
        assert False, "exhausted token should reject a new device"
    except ValueError as exc:
        assert str(exc) == "used"

    event = db.query(EnrollmentAudit).one()
    assert event.result == "failed"
    assert event.reason == "token_used"
    assert db.get(EnrollmentToken, token.id).use_count == token.max_uses


def test_audit_event_written_for_invalid_token():
    db = _db()

    try:
        AgentEnrollmentService(db).enroll(
            _payload("invalid-token-value-123456"),
            heartbeat_url="https://example.test/heartbeat",
            websocket_url="wss://example.test/ws",
        )
        assert False, "invalid token should fail"
    except ValueError as exc:
        assert str(exc) == "invalid"

    event = db.query(EnrollmentAudit).one()
    assert event.token_id is None
    assert event.result == "failed"
    assert event.reason == "token_invalid"


def test_audit_failure_does_not_break_enrollment():
    db = _db()
    token, plaintext = _token(db)
    service = AgentEnrollmentService(db)

    def fail_audit(**_values):
        raise RuntimeError("audit unavailable")

    service.enrollment_audit.record = fail_audit
    response = service.enroll(
        _payload(plaintext),
        heartbeat_url="https://example.test/heartbeat",
        websocket_url="wss://example.test/ws",
    )

    assert response.device_id is not None
    assert db.get(EnrollmentToken, token.id).use_count == 1
    assert db.query(EnrollmentAudit).count() == 0


def test_diagnostics_returns_event_counts():
    db = _db()
    token, _ = _token(db, use_count=4)
    device_one = Device(hostname="one", enrollment_count=2, is_archived=False)
    device_two = Device(hostname="two", enrollment_count=1, is_archived=True)
    db.add_all([device_one, device_two])
    db.commit()
    audit = EnrollmentAuditService(db)
    payload = AgentEnrollmentRequest(hostname="one")
    audit.record(payload=payload, token=token, device=device_one, result="success")
    audit.record(payload=payload, token=token, device=device_one, result="updated_existing")
    audit.record(payload=AgentEnrollmentRequest(hostname="two"), token=token, device=device_two, result="success")
    audit.record(payload=payload, token=token, result="failed", reason="token_used")

    result = audit.diagnostics(token)

    assert result["unique_devices"] == 2
    assert result["duplicate_enrollments"] == 1
    assert result["successful_events"] == 3
    assert result["failed_events"] == 1
    assert result["archived_devices"] == 1
    assert result["orphaned_uses"] == 1


def test_existing_unscoped_token_without_audit_returns_unknown_inference():
    db = _db()
    token, _ = _token(db, use_count=12)

    result = EnrollmentAuditService(db).diagnostics(token)

    assert result["inferred"] is True
    assert result["unique_devices"] is None
    assert result["failed_events"] is None
    assert result["orphaned_uses"] is None
    assert "unknown" in result["inference_note"]


def _diagnostics_client(db, role):
    operator = Operator(
        id=1,
        username=f"{role}-user",
        email=f"{role}@test.local",
        hashed_password="x",
        role=role,
        is_active=True,
    )
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: operator
    app.include_router(enrollment_tokens_router, prefix="/api/v1/enrollment-tokens")
    return TestClient(app, raise_server_exceptions=False)


def test_diagnostics_permission_protection_remains_enforced():
    db = _db()
    token, _ = _token(db)

    operator_response = _diagnostics_client(db, "operator").get(
        f"/api/v1/enrollment-tokens/{token.id}/diagnostics"
    )
    admin_response = _diagnostics_client(db, "admin").get(
        f"/api/v1/enrollment-tokens/{token.id}/diagnostics"
    )

    assert operator_response.status_code == 403
    assert admin_response.status_code == 200
