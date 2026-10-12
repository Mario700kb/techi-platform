import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import system as system_module
from app.core.agent_auth import _SlidingWindowRateLimiter
from app.core.auth import get_current_operator
from app.models.operator import Operator


def _operator(operator_id: int = 7) -> Operator:
    return Operator(id=operator_id, username="op", email="op@test.com", hashed_password="x", role="operator", is_active=True)


def _client(operator=None) -> TestClient:
    app = FastAPI()
    if operator is not None:
        app.dependency_overrides[get_current_operator] = lambda: operator
    app.include_router(system_module.router, prefix="/system")
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _fresh_limiter(monkeypatch):
    monkeypatch.setattr(system_module, "client_error_limiter", _SlidingWindowRateLimiter(limit=3, window_seconds=60))


def test_client_error_is_logged(caplog):
    with caplog.at_level(logging.ERROR, logger="techi.client_errors"):
        response = _client(_operator()).post(
            "/system/client-errors",
            json={"message": "x is undefined", "name": "TypeError", "url": "/devices", "scope": "page"},
        )
    assert response.status_code == 204
    assert "TypeError: x is undefined" in caplog.text
    assert "operator=7" in caplog.text


def test_client_error_requires_authentication():
    response = _client().post("/system/client-errors", json={"message": "boom"})
    assert response.status_code == 401


def test_client_error_is_rate_limited_per_operator():
    client = _client(_operator())
    codes = [client.post("/system/client-errors", json={"message": "loop"}).status_code for _ in range(4)]
    assert codes == [204, 204, 204, 429]


def test_client_error_rejects_oversized_message():
    response = _client(_operator()).post("/system/client-errors", json={"message": "x" * 1001})
    assert response.status_code == 422
