from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import health


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(health.router, prefix="/api/v1")
    return TestClient(app)


def test_ready_when_the_database_answers():
    response = _client().get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_not_ready_when_the_database_is_unreachable():
    with patch.object(health.engine, "connect", side_effect=OSError("connection refused")):
        response = _client().get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json()["database"] == "unreachable"


def test_liveness_does_not_touch_the_database():
    with patch.object(health.engine, "connect", side_effect=AssertionError("liveness must not query")):
        assert _client().get("/api/v1/health").status_code == 200
