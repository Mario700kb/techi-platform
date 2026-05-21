from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import enrollment_tokens as enrollment_tokens_endpoint
from app.core.auth import get_current_operator
from app.core.time import utcnow
from app.db.base import Base
from app.models.enrollment_token import EnrollmentToken
from app.schemas.enrollment_token import EnrollmentTokenCreate, EnrollmentTokenUpdate
from app.services.enrollment_token_service import EnrollmentTokenService


def _service():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine, tables=[EnrollmentToken.__table__])
    session = sessionmaker(bind=engine)()
    return EnrollmentTokenService(session)


def test_edit_max_uses_and_expires_at():
    service = _service()
    created = service.create(EnrollmentTokenCreate(name="GPO", max_uses=25))
    expires_at = utcnow() + timedelta(days=365)

    updated = service.update(
        created.id,
        EnrollmentTokenUpdate(max_uses=500, expires_at=expires_at),
    )

    assert updated.max_uses == 500
    assert updated.expires_at.replace(tzinfo=expires_at.tzinfo) == expires_at


def test_regenerate_replaces_hash_and_returns_plaintext_once():
    service = _service()
    created = service.create(EnrollmentTokenCreate(name="GPO", max_uses=25))
    original = service.repo.get(created.id)
    original_hash = original.token_hash

    regenerated = service.regenerate(created.id)
    refreshed = service.repo.get(created.id)

    assert regenerated.token
    assert refreshed.token_hash != original_hash
    assert refreshed.token_prefix == regenerated.token[:8]
    assert "token_hash" not in regenerated.model_dump()


def test_deployment_command_is_safe_and_has_no_irm_iex():
    service = _service()
    created = service.create(EnrollmentTokenCreate(name="GPO", max_uses=25))

    deployment = service.deployment(created.id, backend_url="https://api-rdp.techi.com.al")

    assert "| iex" not in deployment.manual_command.lower()
    assert "irm " not in deployment.manual_command.lower()
    assert "Invoke-WebRequest" in deployment.manual_command
    assert "-File $BootstrapFile" in deployment.manual_command
    assert "Invoke-WebRequest" in deployment.gpo_command
    assert 'C:\\Windows\\Temp\\techi-bootstrap.ps1' in deployment.gpo_command
    assert deployment.token_available is True


def test_legacy_hash_only_token_requires_regenerate_for_usable_deployment():
    service = _service()
    created = service.create(EnrollmentTokenCreate(name="Legacy", max_uses=25))
    token = service.repo.get(created.id)
    token.token_ciphertext = None
    service.repo.save(token)

    deployment = service.deployment(created.id, backend_url="https://api-rdp.techi.com.al")

    assert deployment.token_available is False
    assert "%3Cregenerate-token-value%3E" in deployment.bootstrap_url


def test_bootstrap_ps1_endpoint_returns_text_plain(monkeypatch):
    class FakeTokenService:
        def __init__(self, _db):
            pass

        def get(self, token_id):
            return type("Token", (), {"id": token_id, "name": "GPO", "token_ciphertext": "cipher"})()

        def decrypt_token(self, _ciphertext):
            return "plaintext-token-value-123"

    class FakeBootstrapService:
        @staticmethod
        def normalize_backend_url(url):
            return url.rstrip("/")

        def __init__(self, _db):
            pass

        def generate(self, _payload):
            return type("Bootstrap", (), {"bootstrap_script": "$ErrorActionPreference = 'Stop'\n"})()

    monkeypatch.setattr(enrollment_tokens_endpoint, "EnrollmentTokenService", FakeTokenService)
    monkeypatch.setattr(enrollment_tokens_endpoint, "EnrollmentBootstrapService", FakeBootstrapService)
    monkeypatch.setattr(enrollment_tokens_endpoint, "audit_log", lambda *args, **kwargs: None)

    app = FastAPI()
    app.include_router(enrollment_tokens_endpoint.router, prefix="/api/v1/enrollment-tokens")
    app.dependency_overrides[enrollment_tokens_endpoint.get_db] = lambda: object()
    app.dependency_overrides[get_current_operator] = lambda: type("Operator", (), {"id": 1, "username": "admin", "role": "admin"})()

    response = TestClient(app).get("/api/v1/enrollment-tokens/7/bootstrap.ps1")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.text.startswith("$ErrorActionPreference")
