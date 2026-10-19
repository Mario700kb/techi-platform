"""Heartbeat overload protection (2026-10-19 16:06–16:18 retry loop).

The guard answers 503 before any thread or database work when too many
heartbeats are in flight, and to an agent whose previous heartbeat is still
being handled; a heartbeat that waited past the delivery deadline gets no
pending actions, so none is marked SENT for an agent that stopped listening.
"""
import asyncio
import json


from app.core.load_guard import HeartbeatGuard, HeartbeatLoad, RequestMetrics


def _scope(path="/api/v1/agent/heartbeat", method="POST"):
    return {"type": "http", "method": method, "path": path, "headers": []}


async def _call(app, body: dict, scope=None):
    sent = []
    payload = json.dumps(body).encode()
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": payload, "more_body": False}
        await asyncio.sleep(3600)

    async def send(message):
        sent.append(message)

    await app(scope or _scope(), receive, send)
    return sent


def _status(sent):
    return next(m["status"] for m in sent if m["type"] == "http.response.start")


class _SlowApp:
    """Stands in for the heartbeat endpoint: holds its slot until released."""

    def __init__(self):
        self.release = asyncio.Event()
        self.bodies = []

    async def __call__(self, scope, receive, send):
        message = await receive()
        self.bodies.append(message["body"])
        await self.release.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})


def test_sheds_when_too_many_heartbeats_are_in_flight():
    async def run():
        inner = _SlowApp()
        guard = HeartbeatGuard(inner, max_in_flight=2, load=HeartbeatLoad())
        first = asyncio.create_task(_call(guard, {"agent_id": "a1"}))
        second = asyncio.create_task(_call(guard, {"agent_id": "a2"}))
        await asyncio.sleep(0.01)
        third = await _call(guard, {"agent_id": "a3"})
        inner.release.set()
        return _status(await first), _status(await second), third, inner.bodies

    first, second, third, bodies = asyncio.run(run())
    assert (first, second) == (200, 200)
    assert _status(third) == 503
    assert any(h[0] == b"retry-after" for h in next(m for m in third if m["type"] == "http.response.start")["headers"])
    assert len(bodies) == 2  # the shed heartbeat never reached the endpoint


def test_sheds_the_retry_of_an_agent_still_being_handled():
    async def run():
        inner = _SlowApp()
        load = HeartbeatLoad()
        guard = HeartbeatGuard(inner, max_in_flight=10, load=load)
        first = asyncio.create_task(_call(guard, {"agent_id": "same", "device_id": 7}))
        await asyncio.sleep(0.01)
        retry = await _call(guard, {"agent_id": "same", "device_id": 7})
        other = asyncio.create_task(_call(guard, {"agent_id": "other"}))
        await asyncio.sleep(0.01)
        inner.release.set()
        results = _status(await first), _status(retry), _status(await other)
        after = await _call(guard, {"agent_id": "same"})  # slot freed once answered
        return results, _status(after), load.take_stats()

    (first, retry, other), after, stats = asyncio.run(run())
    assert (first, retry, other) == (200, 503, 200)
    assert after == 200
    assert stats["shed_duplicate"] == 1 and stats["peak_in_flight"] == 2


def test_other_requests_pass_untouched():
    async def run():
        inner = _SlowApp()
        inner.release.set()
        guard = HeartbeatGuard(inner, max_in_flight=1, load=HeartbeatLoad())
        guard.load.in_flight = 5  # "full"
        return await _call(guard, {"x": 1}, scope=_scope(path="/api/v1/devices", method="GET"))

    assert _status(asyncio.run(run())) == 200


def test_metrics_log_a_summary_line(caplog):
    async def run():
        inner = _SlowApp()
        inner.release.set()
        metrics = RequestMetrics(inner, window_s=0.0, load=HeartbeatLoad())
        await _call(metrics, {}, scope=_scope(path="/api/v1/devices", method="GET"))

    with caplog.at_level("INFO", logger="techi.load"):
        asyncio.run(run())
    assert any("load: 1 requests, 0 5xx" in r.message for r in caplog.records)
