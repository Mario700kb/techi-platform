"""TRUSTED_DOMAIN_AUTO_ENROLLMENT gates token-free enrollment as a whole.

Until 2026-10-16 an active row in trusted_domains let a machine that only
claimed that domain enroll without a token even with the switch off.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.config import settings
from app.db.base import Base
from app.models.device import Device
from app.models.enrollment_audit import EnrollmentAudit
from app.models.trusted_domain import TrustedDomain
from app.schemas.agent import AgentEnrollmentRequest
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.trusted_domain_service import TrustedDomainService


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(TrustedDomain(domain="corp.local", is_active=True))
    session.commit()
    yield session
    session.close()


def _enroll(db):
    payload = AgentEnrollmentRequest(
        hostname="PC-01", domain="CORP.local", current_user="u", platform="windows",
        os_name="Windows 11", local_ip="10.0.0.5", public_ip="203.0.113.5",
    )
    return AgentEnrollmentService(db).enroll(payload, heartbeat_url="https://x/hb", websocket_url="wss://x/ws")


def test_a_listed_domain_does_not_enroll_without_a_token_while_the_switch_is_off(db, monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_DOMAIN_AUTO_ENROLLMENT", False)

    assert TrustedDomainService(db).is_trusted_domain("corp.local", "PC-01") is False
    with pytest.raises(ValueError, match="enrollment_token is required"):
        _enroll(db)

    assert db.query(Device).count() == 0
    audit = db.query(EnrollmentAudit).order_by(EnrollmentAudit.id.desc()).first()
    assert audit.reason == "trusted_domain_auto_enrollment_disabled"


def test_a_listed_domain_enrolls_without_a_token_when_the_switch_is_on(db, monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_DOMAIN_AUTO_ENROLLMENT", True)

    response = _enroll(db)

    assert response.enrollment_status == "enrolled_trusted_domain"
    assert db.query(Device).count() == 1


def test_an_unlisted_domain_does_not_enroll_when_rows_exist(db, monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_DOMAIN_AUTO_ENROLLMENT", True)

    assert TrustedDomainService(db).is_trusted_domain("evil.local", "PC-01") is False
