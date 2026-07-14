from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.remote_support import (
    _connect_url_response_for_device,
    _build_connect_url,
    get_connect_url,
)


def test_connect_url_is_id_only_and_encoded():
    url = _build_connect_url("294 938 618")
    assert url == "techiremotesupport://294%20938%20618"
    assert "password" not in url
    assert "?" not in url


def test_direct_connect_is_fail_closed_and_audited(monkeypatch):
    device = SimpleNamespace(id=590, rustdesk_id="486641675")
    audits = []
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support._get_device",
        lambda *args, **kwargs: device,
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.REMOTE_SUPPORT_DIRECT_CONNECT_ENABLED",
        False,
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.audit_log",
        lambda *args, **kwargs: audits.append(kwargs),
    )

    with pytest.raises(HTTPException) as exc:
        get_connect_url(
            db=None,
            operator=SimpleNamespace(username="operator"),
            scope=None,
            _perm=None,
            device_id=device.id,
        )

    assert exc.value.status_code == 503
    assert audits[0]["details"] == {
        "result": "blocked",
        "reason": "direct_connect_disabled",
    }


def test_connect_url_uses_only_confirmed_active_generation():
    device = SimpleNamespace(
        id=590,
        rustdesk_id="486641675",
        agent_version="2.1.5",
        remote_support_apply_status="applied",
        remote_support_active_generation=2,
        remote_support_applied_generation=2,
        remote_support_state="installed_running",
    )

    response = _connect_url_response_for_device(device, db=None)

    assert response.device_id == 590
    assert response.connect_url == "techiremotesupport://486641675"


@pytest.mark.parametrize("status", ["pending", "failed", "unknown", "unsupported_legacy"])
def test_connect_url_blocks_unconfirmed_credential_state(status):
    device = SimpleNamespace(
        id=590,
        rustdesk_id="486641675",
        agent_version="99.0.0",
        remote_support_apply_status=status,
        remote_support_state="installed_running",
    )

    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(device, db=None)

    assert exc.value.status_code == 409


def test_connect_url_still_rejects_missing_remote_id():
    device = SimpleNamespace(id=590, rustdesk_id="")

    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(device, db=None)

    assert exc.value.status_code == 422


def test_connect_url_rejects_generation_mismatch():
    device = SimpleNamespace(
        id=590,
        rustdesk_id="486641675",
        remote_support_apply_status="applied",
        remote_support_active_generation=3,
        remote_support_applied_generation=2,
        remote_support_state="installed_running",
    )

    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(device, db=None)

    assert exc.value.status_code == 409
