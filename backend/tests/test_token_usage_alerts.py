from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.token_usage_alert_service import build_token_usage_alerts


def _db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine, tables=[EnrollmentToken.__table__])
    return sessionmaker(bind=engine)()


def _token(db, *, name, use_count, max_uses, status=EnrollmentTokenStatus.ACTIVE, is_internal=False):
    token = EnrollmentToken(
        name=name,
        token_hash=EnrollmentTokenService.hash_token(f"{name}-plaintext-1234567890"),
        token_prefix=name[:8],
        status=status,
        max_uses=max_uses,
        use_count=use_count,
        is_internal=is_internal,
    )
    db.add(token)
    db.commit()
    db.refresh(token)
    return token


def test_usage_warning_thresholds():
    db = _db()
    assert _token(db, name="low", use_count=10, max_uses=100).usage_warning is None
    assert _token(db, name="ninety", use_count=90, max_uses=100).usage_warning == "warning"
    assert _token(db, name="full", use_count=100, max_uses=100).usage_warning == "critical"
    assert (
        _token(db, name="revoked", use_count=100, max_uses=100, status=EnrollmentTokenStatus.REVOKED).usage_warning
        is None
    )


def test_build_token_usage_alerts():
    db = _db()
    _token(db, name="Quiet", use_count=5, max_uses=100)
    warn = _token(db, name="Almost", use_count=45, max_uses=50)
    full = _token(db, name="Maxed", use_count=50, max_uses=50, status=EnrollmentTokenStatus.USED)
    _token(db, name="Internal", use_count=999999, max_uses=1000000, is_internal=True)
    _token(db, name="Revoked", use_count=50, max_uses=50, status=EnrollmentTokenStatus.REVOKED)

    alerts = build_token_usage_alerts(db)

    assert len(alerts) == 2
    critical, warning = alerts
    assert critical["id"] == -full.id
    assert critical["kind"] == "token_usage_critical"
    assert critical["severity"] == "critical"
    assert critical["device_id"] is None
    assert critical["token_id"] == full.id
    assert "Maxed enrollment token at 50/50 (100%)" in critical["message"]
    assert warning["id"] == -warn.id
    assert warning["kind"] == "token_usage_warning"
    assert "Almost enrollment token at 45/50 (90%)" in warning["message"]
