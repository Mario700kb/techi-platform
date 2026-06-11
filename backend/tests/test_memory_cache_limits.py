from types import SimpleNamespace

from app.services import device_heartbeat_service
from app.services import device_summary_service
from app.websocket import events


def test_agent_id_cache_evicts_oldest_batch():
    cache = device_heartbeat_service._AGENT_ID_CACHE
    cache.clear()

    for index in range(device_heartbeat_service._AGENT_ID_CACHE_MAX_SIZE + 1):
        device_heartbeat_service._cache_agent_device(f"agent-{index}", index)

    assert len(cache) == 901
    assert "agent-0" not in cache
    assert "agent-99" not in cache
    assert "agent-100" in cache


def test_summary_cache_limits_scope_entries(monkeypatch):
    cache = device_summary_service._summary_cache
    cache.clear()
    service = device_summary_service.DeviceSummaryService(db=object())
    counter = {"value": 0}

    def compute(_scope):
        counter["value"] += 1
        return SimpleNamespace(sequence=counter["value"])

    monkeypatch.setattr(service, "_compute_summary", compute)

    for index in range(device_summary_service._SUMMARY_CACHE_MAX_SIZE + 1):
        scope = SimpleNamespace(
            client_ids=frozenset({index}),
            group_ids=frozenset(),
            device_ids=frozenset(),
        )
        service.get_summary(scope)

    assert len(cache) == device_summary_service._SUMMARY_CACHE_MAX_SIZE
    assert "c[0]g[]d[]" not in cache
    assert "c[10]g[]d[]" in cache


def test_websocket_snapshot_has_hard_limit():
    snapshot = events._ws_snapshot
    snapshot.clear()

    for device_id in range(events._WS_SNAPSHOT_MAX_SIZE + 1):
        events.device_payload_delta({"id": device_id, "status": "online"})

    assert len(snapshot) == events._WS_SNAPSHOT_MAX_SIZE
    assert 0 not in snapshot
    assert events._WS_SNAPSHOT_MAX_SIZE in snapshot
