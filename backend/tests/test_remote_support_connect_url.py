from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.remote_support import (
    _connect_url_response_for_device,
    _build_connect_url,
)
from app.core.time import utcnow


def test_connect_url_includes_encoded_managed_password(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": True},
    )
    monkeypatch.setattr("app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEFAULT_PASSWORD", "Durres.12!")

    assert _build_connect_url("294 938 618") == (
        "techiremotesupport://294%20938%20618?password=Durres.12%21"
    )


def test_connect_url_omits_password_when_feature_disabled(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": False},
    )
    monkeypatch.setattr("app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEFAULT_PASSWORD", "Durres.12")

    assert _build_connect_url("294938618") == "techiremotesupport://294938618"


def test_connect_url_omits_blank_password(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": True},
    )
    monkeypatch.setattr("app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEFAULT_PASSWORD", "   ")

    assert _build_connect_url("294938618") == "techiremotesupport://294938618"


def test_connect_url_allows_stale_agent_heartbeat_when_remote_id_exists(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": False},
    )
    device = SimpleNamespace(
        id=590,
        rustdesk_id="486641675",
        last_seen=utcnow() - timedelta(hours=3),
        rustdesk_status="running",
        rustdesk_install_status="installed",
    )

    response = _connect_url_response_for_device(device)

    assert response.device_id == 590
    assert response.techi_remote_id == "486641675"
    assert response.connect_url == "techiremotesupport://486641675"


def test_connect_url_still_rejects_missing_remote_id():
    device = SimpleNamespace(id=590, rustdesk_id="")

    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(device)

    assert exc.value.status_code == 422
