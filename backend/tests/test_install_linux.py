"""Phase 2 — Linux installer endpoint (flag-gated)."""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import install as install_endpoint
from app.core.config import settings


def _client(monkeypatch, flag_on: bool) -> TestClient:
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", flag_on)
    monkeypatch.setattr(settings, "FEATURE_LINUX", flag_on)
    app = FastAPI()
    app.include_router(install_endpoint.router, prefix="/api/v1/install")
    return TestClient(app)


def test_404_when_flag_off(monkeypatch):
    client = _client(monkeypatch, flag_on=False)
    resp = client.get("/api/v1/install/linux", params={"token": "TKN-1"})
    assert resp.status_code == 404


def test_script_served_when_flag_on(monkeypatch):
    client = _client(monkeypatch, flag_on=True)
    resp = client.get("/api/v1/install/linux", params={"token": "TKN-ABC"})
    assert resp.status_code == 200
    body = resp.text
    assert body.startswith("#!/usr/bin/env bash")
    assert "TOKEN=\"TKN-ABC\"" in body
    assert "linux-${ARCH}/download" in body
    assert "techi-agent" in body
    assert "install --config" in body


def test_token_required(monkeypatch):
    client = _client(monkeypatch, flag_on=True)
    resp = client.get("/api/v1/install/linux")
    assert resp.status_code == 422
