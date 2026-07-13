from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.remote_support import (
    _connect_url_response_for_device,
    _build_connect_url,
)


def test_connect_url_includes_encoded_per_device_password(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": True},
    )
    assert _build_connect_url("294 938 618", "Durres.12!") == (
        "techiremotesupport://294%20938%20618?password=Durres.12%21"
    )


def test_connect_url_omits_password_when_feature_disabled(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": False},
    )
    assert _build_connect_url("294938618", "anything") == "techiremotesupport://294938618"


def test_connect_url_omits_blank_password(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": True},
    )
    assert _build_connect_url("294938618", "   ") == "techiremotesupport://294938618"


def test_connect_url_uses_only_confirmed_active_generation(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.agent_config_service.get_policy",
        lambda: {"remote_support_managed_password_enabled": True},
    )

    class FakePwSvc:
        def __init__(self, db):
            pass

        def get_active_plaintext(self, device):
            return "UniquePerDevice9"

    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.RemoteSupportPasswordService", FakePwSvc
    )
    device = SimpleNamespace(
        id=590,
        rustdesk_id="486641675",
        agent_version="2.1.5",
        remote_support_apply_status="applied",
        remote_support_active_generation=2,
        remote_support_applied_generation=2,
    )

    response = _connect_url_response_for_device(device, db=None)

    assert response.device_id == 590
    assert response.connect_url == "techiremotesupport://486641675?password=UniquePerDevice9"


@pytest.mark.parametrize("status", ["pending", "failed", "unknown", "unsupported_legacy"])
def test_connect_url_blocks_unconfirmed_credential_state(monkeypatch, status):
    class BoomPwSvc:
        def __init__(self, db):
            pass

        def get_active_plaintext(self, device):
            raise AssertionError("unconfirmed credentials must not be revealed")

    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.RemoteSupportPasswordService", BoomPwSvc
    )
    device = SimpleNamespace(
        id=590,
        rustdesk_id="486641675",
        agent_version="99.0.0",
        remote_support_apply_status=status,
    )

    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(device, db=None)

    assert exc.value.status_code == 409


def test_connect_url_still_rejects_missing_remote_id():
    device = SimpleNamespace(id=590, rustdesk_id="")

    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(device, db=None)

    assert exc.value.status_code == 422


def test_connect_url_rejects_generation_mismatch(monkeypatch):
    class FakePwSvc:
        def __init__(self, db):
            pass

        def get_active_plaintext(self, device):
            return "ConfirmedButMismatched9"

    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.RemoteSupportPasswordService", FakePwSvc
    )
    device = SimpleNamespace(
        id=590,
        rustdesk_id="486641675",
        remote_support_apply_status="applied",
        remote_support_active_generation=3,
        remote_support_applied_generation=2,
    )

    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(device, db=None)

    assert exc.value.status_code == 409
