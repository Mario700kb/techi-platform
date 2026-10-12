"""The API description is for signed-in admins, not the public internet."""
import os

import pytest
from fastapi.testclient import TestClient

from app.core.auth import get_current_operator
from app.models.operator import Operator


@pytest.fixture()
def app(tmp_path, monkeypatch):
    os.environ.setdefault("DEV_ALLOW_RANDOM_SECRET", "true")
    # app.main configures file logging at import; keep it out of /app/logs.
    monkeypatch.setenv("LOG_DIR", str(tmp_path))
    from app.main import app as main_app

    yield main_app
    main_app.dependency_overrides.clear()


def _as(app, role):
    app.dependency_overrides[get_current_operator] = lambda: Operator(id=1, username="u", role=role, is_active=True)
    return TestClient(app)


@pytest.mark.parametrize("path", ["/api/v1/docs", "/api/v1/openapi.json"])
def test_anonymous_gets_401(app, path):
    assert TestClient(app).get(path).status_code == 401


@pytest.mark.parametrize("path", ["/api/v1/docs", "/api/v1/openapi.json"])
def test_operator_gets_403(app, path):
    assert _as(app, "operator").get(path).status_code == 403


def test_admin_gets_the_schema_and_the_ui(app):
    client = _as(app, "admin")
    schema = client.get("/api/v1/openapi.json")
    assert schema.status_code == 200
    assert "/api/v1/auth/login" in schema.json()["paths"]
    ui = client.get("/api/v1/docs")
    assert ui.status_code == 200
    assert "swagger-ui" in ui.text
