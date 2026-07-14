from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.remote_support import (
    _build_connect_url,
    _connect_url_response_for_device,
    _get_device,
    get_connect_url,
)
from app.core.scope import AllowedScope
from app.core.time import utcnow


def _device(**overrides):
    values = {
        "id": 590,
        "rustdesk_id": "486641675",
        "rustdesk_conflict_detected": False,
        "last_seen": utcnow(),
        "remote_support_state": "unknown",
        "heartbeat_auth_state": "authenticated",
        "agent_version": "2.1.11",
        "status": "online",
        "client_id": 10,
        "group_id": 20,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_connect_url_is_id_only_and_encoded():
    url = _build_connect_url("294 938 618")
    assert url == "techiremotesupport://294%20938%20618"
    assert "password" not in url
    assert "?" not in url


def test_id_only_launcher_ignores_credential_automation_flag_and_is_audited(monkeypatch):
    device = _device(remote_support_state="unknown")
    audits = []
    monkeypatch.setattr("app.api.v1.endpoints.remote_support._get_device", lambda *args, **kwargs: device)
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.REMOTE_SUPPORT_DIRECT_CONNECT_ENABLED",
        False,
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.audit_log",
        lambda *args, **kwargs: audits.append(kwargs),
    )

    response = get_connect_url(
        db=None,
        operator=SimpleNamespace(username="operator"),
        scope=None,
        _perm=None,
        device_id=device.id,
    )

    assert response.connect_url == "techiremotesupport://486641675"
    assert audits[0]["details"] == {
        "launcher": "id_only",
        "remote_support_status": "warning",
        "credential_in_url": False,
    }
    assert "password" not in response.connect_url.lower()


@pytest.mark.parametrize(
    "case",
    [
        {"status": "online", "remote_support_state": "installed_running"},
        {"status": "offline", "last_seen": utcnow() - timedelta(days=2)},
        {"status": "online", "remote_support_state": "damaged"},
        {"heartbeat_auth_state": "legacy_restricted", "remote_support_state": "legacy_status_unavailable"},
        {"remote_support_state": "unknown"},
    ],
    ids=["agent-online", "agent-offline", "agent-degraded", "legacy-restricted", "rs-unknown"],
)
def test_remote_id_keeps_launcher_available_independent_of_agent_and_rs_state(case):
    response = _connect_url_response_for_device(_device(**case), db=None)
    assert response.connect_url == "techiremotesupport://486641675"


@pytest.mark.parametrize("remote_id", [None, "", "unknown", "pending_device", "bad id!"])
def test_connect_url_rejects_missing_or_invalid_remote_id(remote_id):
    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(_device(rustdesk_id=remote_id), db=None)
    assert exc.value.status_code == 422


def test_connect_url_rejects_remote_id_conflict():
    with pytest.raises(HTTPException) as exc:
        _connect_url_response_for_device(_device(rustdesk_conflict_detected=True), db=None)
    assert exc.value.status_code == 409


def test_cross_tenant_device_is_hidden(monkeypatch):
    device = _device(client_id=77, group_id=88)
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.DeviceService.get_device",
        lambda *args, **kwargs: device,
    )
    with pytest.raises(HTTPException) as exc:
        _get_device(device.id, db=None, scope=AllowedScope(client_ids=frozenset({10})))
    assert exc.value.status_code == 404
