"""Agent command channel — push delivery for interactive actions.

Opening a Web Terminal took ~200s because the agent only learned a session
existed on its next heartbeat. The channel lets the server push instead. It is
strictly an accelerator: every action is still persisted first, and an agent
that is not connected is served by the heartbeat path exactly as before.

These tests pin the properties that make it safe to add:
  - a push is never required for correctness
  - a failed push leaves the action deliverable by heartbeat
  - registration requires the device's own agent_id
  - an action pushed is marked SENT, so heartbeat cannot deliver it twice
"""

import asyncio

import pytest

from app.websocket.agent_channel import AgentCommandChannel


class _FakeWS:
    def __init__(self, fail: bool = False):
        self.sent = []
        self.closed = False
        self._fail = fail

    async def send_json(self, payload):
        if self._fail:
            raise RuntimeError("socket gone")
        self.sent.append(payload)

    async def close(self):
        self.closed = True


@pytest.fixture
def channel():
    # A current event loop is guaranteed by the autouse fixture in conftest.py;
    # on Python 3.9 the Lock in AgentCommandChannel.__init__ needs one.
    return AgentCommandChannel()


# ── registry ─────────────────────────────────────────────────────────────── #

def test_push_to_unconnected_device_reports_failure(channel):
    """The caller must be able to tell that heartbeat still has to deliver."""
    assert asyncio.run(channel.push(729, {"type": "action"})) is False
    assert channel.is_connected(729) is False


def test_push_reaches_a_connected_agent(channel):
    ws = _FakeWS()

    async def scenario():
        await channel.register(729, ws)
        return await channel.push(729, {"type": "action", "action": {"action_id": 1}})

    assert asyncio.run(scenario()) is True
    assert ws.sent == [{"type": "action", "action": {"action_id": 1}}]


def test_a_dead_socket_degrades_to_false_and_is_evicted(channel):
    """A push failure must not raise: the action is already persisted and the
    heartbeat path is the fallback."""
    ws = _FakeWS(fail=True)

    async def scenario():
        await channel.register(729, ws)
        pushed = await channel.push(729, {"type": "action"})
        return pushed, channel.is_connected(729)

    pushed, still_connected = asyncio.run(scenario())
    assert pushed is False
    assert still_connected is False, "a socket that failed must not stay registered"


def test_reconnect_replaces_the_stale_connection(channel):
    """Two sockets for one device would race to receive a push."""
    old, new = _FakeWS(), _FakeWS()

    async def scenario():
        await channel.register(729, old)
        await channel.register(729, new)
        await channel.push(729, {"type": "action"})
        return await channel.connection_count()

    assert asyncio.run(scenario()) == 1
    assert old.closed is True
    assert new.sent and not old.sent


def test_slow_disconnect_cannot_evict_its_replacement(channel):
    """Unregister must only clear the socket it owns — otherwise a late
    teardown silently kills the connection that already replaced it."""
    old, new = _FakeWS(), _FakeWS()

    async def scenario():
        await channel.register(729, old)
        await channel.register(729, new)
        await channel.unregister(729, old)   # the late teardown arrives now
        return channel.is_connected(729)

    assert asyncio.run(scenario()) is True


def test_devices_are_isolated(channel):
    a, b = _FakeWS(), _FakeWS()

    async def scenario():
        await channel.register(1, a)
        await channel.register(2, b)
        await channel.push(1, {"for": 1})

    asyncio.run(scenario())
    assert a.sent and not b.sent


# ── authentication ───────────────────────────────────────────────────────── #

def test_agent_id_comparison_rejects_absence_and_mismatch():
    """Same knowledge barrier as the heartbeat gate: both sides must be
    non-empty, so a device with no agent_id is never unlocked by a caller that
    also omits it (RISK-SEC-002)."""
    from app.websocket.agent_channel_routes import _agent_id_matches

    assert _agent_id_matches("agent_abc", "agent_abc") is True
    assert _agent_id_matches("agent_abc", "agent_xyz") is False
    assert _agent_id_matches("", "agent_abc") is False
    assert _agent_id_matches("agent_abc", "") is False
    assert _agent_id_matches("", "") is False
    assert _agent_id_matches("  ", "agent_abc") is False


# ── double-delivery ──────────────────────────────────────────────────────── #

def test_pushed_action_is_marked_sent(monkeypatch):
    """Without this the next heartbeat re-delivers the same action and the
    agent opens a second terminal."""
    from app.services import remote_action_service as ras

    marked = {}

    class _Repo:
        def mark_sent(self, action):
            marked["id"] = action.id
            action.status = "sent"
            return action

    class _Action:
        id = 42
        device_id = 729
        action_type = "open_terminal"
        payload_dict = {"session_id": "s"}
        execution_timeout_seconds = 310
        status = "queued"

    svc = ras.RemoteActionService.__new__(ras.RemoteActionService)
    svc.repo = _Repo()
    monkeypatch.setattr(ras, "_publish_action_status", lambda *a, **k: None)
    monkeypatch.setattr(ras, "compute_callback_token", lambda _id: "tok")

    delivery = svc.deliver_now(_Action())
    assert marked["id"] == 42
    assert delivery.action_id == 42
    assert delivery.timeout_seconds == 310
    assert delivery.callback_secret == "tok"


# ── delivery ordering (regression: 2026-08-05 terminal outage) ───────────── #

def test_build_delivery_does_not_change_status():
    """The payload must be constructible without committing to delivery.

    Marking SENT before the frame is on the wire is unrecoverable: the
    heartbeat path collects only QUEUED actions, so an action marked SENT that
    was never pushed is delivered by nobody, and the duplicate-action guard
    then blocks every retry.
    """
    from app.services import remote_action_service as ras

    class _Action:
        id = 7
        device_id = 729
        action_type = "open_terminal"
        payload_dict = {"session_id": "s"}
        execution_timeout_seconds = 310
        status = "queued"

    svc = ras.RemoteActionService.__new__(ras.RemoteActionService)
    action = _Action()
    delivery = svc.build_delivery(action)

    assert action.status == "queued", "build_delivery must not mutate the action"
    assert delivery.action_id == 7
    assert delivery.timeout_seconds == 310


def test_push_from_a_sync_endpoint_uses_the_captured_loop(monkeypatch):
    """Sync endpoints run in a worker thread where get_running_loop() raises.

    This is the exact 2026-08-05 defect: the push raised RuntimeError after the
    action had already been marked SENT, so the terminal broke completely while
    reporting success.
    """
    import asyncio
    import threading

    from app.websocket import agent_channel as ch

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        ch.set_main_loop(loop)
        channel = ch.agent_command_channel
        ws = _FakeWS()
        asyncio.run_coroutine_threadsafe(channel.register(729, ws), loop).result(5)

        marked = {"sent": False}

        class _Svc:
            def build_delivery(self, action):
                class _D:
                    def model_dump(self_inner):
                        return {"action_id": 7}
                return _D()

            def mark_delivered(self, action):
                marked["sent"] = True

        from app.api.v1.endpoints import terminal as term

        # Called from this thread, which has no running loop — same as FastAPI's
        # worker thread. It must still deliver.
        assert term._push_action_if_connected(729, object(), _Svc()) is True
        assert ws.sent == [{"type": "action", "action": {"action_id": 7}}]
        assert marked["sent"] is True, "a confirmed push must mark the action SENT"

        asyncio.run_coroutine_threadsafe(channel.unregister(729, ws), loop).result(5)
    finally:
        ch.set_main_loop(None)
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()


def test_failed_push_leaves_the_action_unmarked(monkeypatch):
    """A dead socket must leave the action deliverable by heartbeat."""
    import asyncio
    import threading

    from app.websocket import agent_channel as ch

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        ch.set_main_loop(loop)
        channel = ch.agent_command_channel
        ws = _FakeWS(fail=True)
        asyncio.run_coroutine_threadsafe(channel.register(729, ws), loop).result(5)

        marked = {"sent": False}

        class _Svc:
            def build_delivery(self, action):
                class _D:
                    def model_dump(self_inner):
                        return {"action_id": 7}
                return _D()

            def mark_delivered(self, action):
                marked["sent"] = True

        from app.api.v1.endpoints import terminal as term

        assert term._push_action_if_connected(729, object(), _Svc()) is False
        assert marked["sent"] is False, "a failed push must not mark the action SENT"
    finally:
        ch.set_main_loop(None)
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()


def test_no_captured_loop_degrades_to_heartbeat():
    """Before startup completes there is no loop; that must not raise."""
    from app.websocket import agent_channel as ch
    from app.api.v1.endpoints import terminal as term

    ws = _FakeWS()
    import asyncio
    asyncio.run(ch.agent_command_channel.register(729, ws))
    ch.set_main_loop(None)
    try:
        assert term._push_action_if_connected(729, object(), None) is False
    finally:
        asyncio.run(ch.agent_command_channel.unregister(729, ws))
