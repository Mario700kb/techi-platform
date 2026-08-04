"""
Guardrails added after the 2026-08-03 heartbeat collapse.

A single vCPU serving 790 endpoints was taken down by lowering the Windows
heartbeat interval 300s -> 180s from the UI. The static HEARTBEAT_INTERVAL_MIN
of 60 would have allowed ~13 req/s with no warning at all: the bound knew
nothing about fleet size or host capacity.

Covers:
- capacity_floor_seconds derives a floor from fleet size / rate budget
- the floor is clamped to [MIN, MAX] and disabled cleanly at budget 0
- PUT /agent-config rejects an interval below the floor, for the flat field and
  for per-platform maps, with the projected rate in the message
- PUT still accepts an interval at or above the floor
- GET/PUT surface the capacity context used to make the decision
- the access-log filter still drops noisy lines and now counts them
- the RISK-IDENT-001 heartbeat instrumentation fires only on a real mismatch
"""

import logging
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import agent_config as ac
from app.api.v1.endpoints.agent_config import router as agent_config_router
from app.core.auth import get_current_operator
from app.core.logging_config import _DropNoisyAccessLogs
from app.db.session import get_db
from app.models.operator import Operator
from app.services import agent_config_service as svc
from app.services import device_heartbeat_service as dhs


FLEET = 790


def _operator() -> Operator:
    return Operator(
        id=1,
        username="admin",
        email="admin@test.com",
        hashed_password="x",
        role="admin",
        is_active=True,
        is_superuser=False,
    )


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(svc, "_POLICY_FILE", str(tmp_path / "policy.json"))
    monkeypatch.setattr(svc, "_policy", None, raising=False)
    monkeypatch.setattr(ac, "_active_device_count", lambda db: FLEET)

    app = FastAPI()
    app.include_router(agent_config_router, prefix="/agent-config")
    app.dependency_overrides[get_current_operator] = _operator
    app.dependency_overrides[get_db] = lambda: None
    return TestClient(app)


# ── capacity_floor_seconds ───────────────────────────────────────────────── #

def test_floor_is_derived_from_fleet_and_budget(monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    # 790 devices at 3 req/s needs at least ceil(790/3) = 264s
    assert svc.capacity_floor_seconds(790) == 264


def test_floor_tightens_as_the_fleet_grows(monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    assert svc.capacity_floor_seconds(1500) > svc.capacity_floor_seconds(790)


def test_floor_relaxes_when_the_budget_is_raised(monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    tight = svc.capacity_floor_seconds(790)
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 8.0)
    assert svc.capacity_floor_seconds(790) < tight


def test_floor_never_below_static_minimum(monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 1000.0)
    assert svc.capacity_floor_seconds(10) == svc.HEARTBEAT_INTERVAL_MIN


def test_floor_never_above_maximum(monkeypatch):
    """A fleet too large for any allowed interval is a hardware problem — it
    must not make the policy unsettable."""
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 0.5)
    assert svc.capacity_floor_seconds(100000) == svc.HEARTBEAT_INTERVAL_MAX


def test_budget_zero_disables_the_derived_floor(monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 0.0)
    assert svc.capacity_floor_seconds(790) == svc.HEARTBEAT_INTERVAL_MIN


def test_empty_fleet_falls_back_to_static_minimum():
    assert svc.capacity_floor_seconds(0) == svc.HEARTBEAT_INTERVAL_MIN


def test_projected_rate():
    assert svc.projected_requests_per_second(790, 300) == 2.63
    assert svc.projected_requests_per_second(790, 180) == 4.39
    assert svc.projected_requests_per_second(790, 0) == 0.0


# ── the endpoint ─────────────────────────────────────────────────────────── #

def test_the_exact_change_that_caused_the_incident_is_rejected(client, monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    r = client.put("/agent-config", json={"heartbeat_interval_seconds": 180})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "180" in detail and "264" in detail
    assert "4.39" in detail  # the projected rate is shown, not just the verdict


def test_safe_interval_is_accepted(client, monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    r = client.put("/agent-config", json={"heartbeat_interval_seconds": 300})
    assert r.status_code == 200
    assert r.json()["heartbeat_interval_seconds"] == 300


def test_per_platform_map_is_guarded_too(client, monkeypatch):
    """The flat field is not the only way in — the incident could equally have
    come through the per-platform map."""
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    r = client.put("/agent-config", json={"platform_heartbeat_intervals": {"windows": 120}})
    assert r.status_code == 422
    assert "windows" in r.json()["detail"]


def test_a_platform_is_charged_only_for_its_own_devices(monkeypatch, tmp_path):
    """Regression in the guard itself (2026-08-04).

    The first version charged the whole fleet to every platform, so on a fleet
    of 791 devices with a single Linux endpoint it refused `linux: 60` — a
    change whose real cost is 1/60 = 0.02 req/s. An interval is per-platform;
    the load it creates is that platform's device count.
    """
    monkeypatch.setattr(svc, "_POLICY_FILE", str(tmp_path / "policy.json"))
    monkeypatch.setattr(svc, "_policy", None, raising=False)
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)

    class _CountByPlatform:
        def count(self, platform=None):
            return {"linux": 1, "mikrotik": 2}.get(platform, 791)

    monkeypatch.setattr(ac, "_active_device_count", lambda db: 791)
    monkeypatch.setattr(ac, "DeviceRepository", lambda db: _CountByPlatform())

    app = FastAPI()
    app.include_router(agent_config_router, prefix="/agent-config")
    app.dependency_overrides[get_current_operator] = _operator
    app.dependency_overrides[get_db] = lambda: None
    c = TestClient(app)

    # One Linux endpoint at 60s is 0.02 req/s — must be allowed.
    assert c.put("/agent-config", json={"platform_heartbeat_intervals": {"linux": 60}}).status_code == 200
    # Two MikroTik routers at 60s is 0.03 req/s — also fine.
    assert c.put("/agent-config", json={"platform_heartbeat_intervals": {"mikrotik": 60}}).status_code == 200
    # Windows still carries the whole fleet and must still be refused.
    r = c.put("/agent-config", json={"platform_heartbeat_intervals": {"windows": 60}})
    assert r.status_code == 422
    assert "791" in r.json()["detail"]


def test_platform_count_failure_falls_back_to_the_fleet_total(monkeypatch, tmp_path):
    """Conservative direction: if the per-platform count cannot be read, charge
    the whole fleet rather than waving the change through."""
    monkeypatch.setattr(svc, "_POLICY_FILE", str(tmp_path / "policy.json"))
    monkeypatch.setattr(svc, "_policy", None, raising=False)
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)

    class _Boom:
        def count(self, platform=None):
            raise RuntimeError("db down")

    monkeypatch.setattr(ac, "_active_device_count", lambda db: 791)
    monkeypatch.setattr(ac, "DeviceRepository", lambda db: _Boom())

    app = FastAPI()
    app.include_router(agent_config_router, prefix="/agent-config")
    app.dependency_overrides[get_current_operator] = _operator
    app.dependency_overrides[get_db] = lambda: None
    r = TestClient(app).put("/agent-config", json={"platform_heartbeat_intervals": {"linux": 60}})
    assert r.status_code == 422


def test_inventory_intervals_are_not_affected(client, monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    r = client.put("/agent-config", json={"platform_inventory_intervals": {"windows": 900}})
    assert r.status_code == 200


def test_get_exposes_capacity_context(client, monkeypatch):
    monkeypatch.setattr(svc, "HEARTBEAT_RATE_BUDGET_PER_SEC", 3.0)
    body = client.get("/agent-config").json()
    assert body["active_device_count"] == FLEET
    assert body["minimum_allowed_interval_seconds"] == 264
    assert body["projected_requests_per_second"] > 0


def test_device_count_failure_degrades_to_static_floor(monkeypatch, tmp_path):
    """A guardrail that 500s is worse than one that degrades."""
    monkeypatch.setattr(svc, "_POLICY_FILE", str(tmp_path / "policy.json"))
    monkeypatch.setattr(svc, "_policy", None, raising=False)

    class _Boom:
        def count(self):
            raise RuntimeError("db down")

    monkeypatch.setattr(ac, "DeviceRepository", lambda db: _Boom())
    app = FastAPI()
    app.include_router(agent_config_router, prefix="/agent-config")
    app.dependency_overrides[get_current_operator] = _operator
    app.dependency_overrides[get_db] = lambda: None
    r = TestClient(app).get("/agent-config")
    assert r.status_code == 200
    assert r.json()["active_device_count"] == 0


# ── access-log filter ────────────────────────────────────────────────────── #

def _record(msg: str) -> logging.LogRecord:
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, msg, None, None)


def test_filter_still_drops_noisy_lines_and_keeps_the_rest():
    f = _DropNoisyAccessLogs()
    assert f.filter(_record('POST /api/v1/agent/heartbeat HTTP/1.1" 200')) is False
    assert f.filter(_record('GET /health HTTP/1.1" 200')) is False
    assert f.filter(_record('GET /api/v1/devices/ HTTP/1.1" 200')) is True


def test_filter_counts_what_it_drops():
    f = _DropNoisyAccessLogs()
    for _ in range(5):
        f.filter(_record('POST /api/v1/agent/heartbeat HTTP/1.1" 200'))
    assert f._counts["/api/v1/agent/heartbeat"] == 5


def test_filter_emits_a_summary_and_resets_the_window(caplog):
    f = _DropNoisyAccessLogs()
    f.SUMMARY_INTERVAL_SECONDS = 0.0  # force the window closed
    with caplog.at_level(logging.INFO, logger="techi.access_summary"):
        f.filter(_record('POST /api/v1/agent/heartbeat HTTP/1.1" 200'))
    assert "suppressed access logs" in caplog.text
    assert f._counts == {}


# ── RISK-IDENT-001 instrumentation ───────────────────────────────────────── #

def _clear_seen():
    dhs._UNVERIFIED_DEVICE_ID_SEEN.clear()


def test_mismatched_agent_id_is_reported(caplog):
    _clear_seen()
    payload = SimpleNamespace(agent_id="agent_theirs", hostname="LAPTOP-TECHI")
    device = SimpleNamespace(id=774, agent_id="agent_ours")
    with caplog.at_level(logging.WARNING):
        dhs._note_unverified_device_id_resolution(payload, device)
    assert "RISK-IDENT-001" in caplog.text
    assert "774" in caplog.text


def test_matching_agent_id_is_silent(caplog):
    _clear_seen()
    payload = SimpleNamespace(agent_id="agent_same", hostname="h")
    device = SimpleNamespace(id=1, agent_id="agent_same")
    with caplog.at_level(logging.WARNING):
        dhs._note_unverified_device_id_resolution(payload, device)
    assert caplog.text == ""


@pytest.mark.parametrize("provided,stored", [("", "a"), ("a", ""), ("", "")])
def test_missing_agent_id_on_either_side_is_silent(caplog, provided, stored):
    """Absence is not disagreement — only a genuine mismatch is interesting."""
    _clear_seen()
    payload = SimpleNamespace(agent_id=provided, hostname="h")
    device = SimpleNamespace(id=2, agent_id=stored)
    with caplog.at_level(logging.WARNING):
        dhs._note_unverified_device_id_resolution(payload, device)
    assert caplog.text == ""


def test_unresolved_device_is_silent(caplog):
    _clear_seen()
    with caplog.at_level(logging.WARNING):
        dhs._note_unverified_device_id_resolution(SimpleNamespace(agent_id="a", hostname="h"), None)
    assert caplog.text == ""


def test_repeat_offender_is_throttled(caplog):
    """A device stuck in this state must not write a line per heartbeat."""
    _clear_seen()
    payload = SimpleNamespace(agent_id="agent_theirs", hostname="h")
    device = SimpleNamespace(id=99, agent_id="agent_ours")
    with caplog.at_level(logging.WARNING):
        for _ in range(10):
            dhs._note_unverified_device_id_resolution(payload, device)
    assert caplog.text.count("RISK-IDENT-001") == 1
