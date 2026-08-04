"""Web Terminal relay (Platform Expansion Phase 5): pairing, cleanup,
idle-timeout / max-duration detection.

TerminalRelay's asyncio.Lock() must be constructed while a loop is running
(Python 3.9's get_event_loop() fallback breaks once any other test in the
suite has already called asyncio.run()), so every test builds its relay
instance INSIDE the asyncio.run()'d coroutine, not before it — matching this
repo's asyncio.run()-per-test convention (see test_websocket_scope.py).
"""

import asyncio

from app.services import terminal_relay as relay_module
from app.services.terminal_relay import TerminalRelay


class _FakeWS:
    def __init__(self, messages=None):
        self.closed = False
        self._messages = list(messages or [])
        self.sent_bytes = []
        self.sent_text = []

    async def close(self):
        self.closed = True

    async def receive(self):
        if self._messages:
            return self._messages.pop(0)
        return {"type": "websocket.disconnect"}

    async def send_bytes(self, data):
        self.sent_bytes.append(data)

    async def send_text(self, data):
        self.sent_text.append(data)


def _set_clock(monkeypatch, value):
    monkeypatch.setattr(relay_module.time, "monotonic", lambda: value)


def test_fresh_pair_has_no_violations(monkeypatch):
    async def _body():
        relay = TerminalRelay()
        _set_clock(monkeypatch, 1000.0)
        await relay.attach_operator("s1", _FakeWS())
        await relay.attach_agent("s1", _FakeWS())
        assert relay.idle_and_expired_sessions(idle_timeout_seconds=900, max_session_seconds=3600) == {}

    asyncio.run(_body())


def test_idle_timeout_detected(monkeypatch):
    async def _body():
        relay = TerminalRelay()
        _set_clock(monkeypatch, 1000.0)
        await relay.attach_operator("s1", _FakeWS())
        await relay.attach_agent("s1", _FakeWS())
        _set_clock(monkeypatch, 1000.0 + 901)
        violations = relay.idle_and_expired_sessions(idle_timeout_seconds=900, max_session_seconds=3600)
        assert violations == {"s1": "idle_timeout"}

    asyncio.run(_body())


def test_idle_timeout_applies_to_half_attached_orphan_pair(monkeypatch):
    # Operator connects, agent never dials in (e.g. device offline) — must
    # still be swept, not leak forever.
    async def _body():
        relay = TerminalRelay()
        _set_clock(monkeypatch, 1000.0)
        await relay.attach_operator("s1", _FakeWS())
        _set_clock(monkeypatch, 1000.0 + 901)
        violations = relay.idle_and_expired_sessions(idle_timeout_seconds=900, max_session_seconds=3600)
        assert violations == {"s1": "idle_timeout"}

    asyncio.run(_body())


def test_max_duration_detected_even_with_recent_activity(monkeypatch):
    async def _body():
        relay = TerminalRelay()
        _set_clock(monkeypatch, 1000.0)
        await relay.attach_operator("s1", _FakeWS())
        await relay.attach_agent("s1", _FakeWS())
        _set_clock(monkeypatch, 1000.0 + 3601)
        violations = relay.idle_and_expired_sessions(idle_timeout_seconds=900, max_session_seconds=3600)
        assert violations == {"s1": "max_duration"}

    asyncio.run(_body())


def test_closed_pair_not_flagged(monkeypatch):
    async def _body():
        relay = TerminalRelay()
        _set_clock(monkeypatch, 1000.0)
        await relay.attach_operator("s1", _FakeWS())
        await relay.attach_agent("s1", _FakeWS())
        await relay.close("s1")
        _set_clock(monkeypatch, 1000.0 + 99999)
        assert relay.idle_and_expired_sessions(idle_timeout_seconds=900, max_session_seconds=3600) == {}

    asyncio.run(_body())


def test_close_closes_both_sockets_and_removes_pair():
    async def _body():
        relay = TerminalRelay()
        op_ws, agent_ws = _FakeWS(), _FakeWS()
        await relay.attach_operator("s1", op_ws)
        await relay.attach_agent("s1", agent_ws)
        assert relay.is_active("s1") is True
        await relay.close("s1")
        assert op_ws.closed is True
        assert agent_ws.closed is True
        assert relay.is_active("s1") is False

    asyncio.run(_body())


def test_close_unknown_session_is_a_noop():
    async def _body():
        relay = TerminalRelay()
        await relay.close("does-not-exist")  # must not raise

    asyncio.run(_body())


def test_pump_relays_bytes_and_text_between_sides():
    async def _body():
        relay = TerminalRelay()
        operator_ws = _FakeWS(messages=[
            {"type": "websocket.receive", "text": "ls\n"},
            {"type": "websocket.receive", "bytes": b"\x01\x02"},
        ])
        agent_ws = _FakeWS()
        await relay.attach_agent("s1", agent_ws)
        await relay.attach_operator("s1", operator_ws)
        await relay.pump("s1", operator_ws, is_operator=True)
        assert agent_ws.sent_text == ["ls\n"]
        assert agent_ws.sent_bytes == [b"\x01\x02"]

    asyncio.run(_body())


def test_pump_activity_resets_idle_clock(monkeypatch):
    async def _body():
        relay = TerminalRelay()
        _set_clock(monkeypatch, 1000.0)
        operator_ws = _FakeWS()
        agent_ws = _FakeWS()
        await relay.attach_agent("s1", agent_ws)
        await relay.attach_operator("s1", operator_ws)

        _set_clock(monkeypatch, 1500.0)  # 500s idle so far — within the 900s window
        operator_ws._messages = [{"type": "websocket.receive", "text": "x"}]
        await relay.pump("s1", operator_ws, is_operator=True)

        _set_clock(monkeypatch, 1500.0 + 899)
        assert relay.idle_and_expired_sessions(900, 3600) == {}
        _set_clock(monkeypatch, 1500.0 + 901)
        assert relay.idle_and_expired_sessions(900, 3600) == {"s1": "idle_timeout"}

    asyncio.run(_body())


def test_pump_stops_when_target_side_never_attached():
    # Operator connects and sends a keystroke before the agent ever dials in
    # — pump must not hang, and must not raise.
    async def _body():
        relay = TerminalRelay()
        operator_ws = _FakeWS(messages=[{"type": "websocket.receive", "text": "x"}])
        await relay.attach_operator("s1", operator_ws)
        await relay.pump("s1", operator_ws, is_operator=True)  # must return, not hang

    asyncio.run(_body())


# ── early operator frames (regression: Web Terminal never opened) ─────────── #

def test_operator_frame_before_agent_attaches_does_not_end_the_session():
    """The operator always attaches first, and xterm.js sends a resize frame
    the instant its socket opens. Treating that frame as "counterpart missing,
    stop" ended every session before the agent could dial back — the Web
    Terminal was unusable on device 729 for exactly this reason (2026-08-05).
    """
    async def scenario():
        r = TerminalRelay()
        operator = _FakeWS([
            {"type": "websocket.receive", "text": '{"t":"resize","cols":80,"rows":24}'},
            {"type": "websocket.receive", "bytes": b"whoami\n"},
        ])
        await r.attach_operator("s1", operator)
        # No agent yet. pump must drain the operator without tearing down.
        await r.pump("s1", operator, is_operator=True)
        pair = r._pairs["s1"]
        return [
            m.get("text") or m.get("bytes") for m in pair.pending_to_agent
        ]

    held = asyncio.run(scenario())
    assert held == ['{"t":"resize","cols":80,"rows":24}', b"whoami\n"], (
        "frames sent before the agent arrived must be held, not dropped"
    )


def test_buffered_frames_are_replayed_when_the_agent_attaches():
    """Losing the initial resize leaves the remote PTY at default geometry."""
    async def scenario():
        r = TerminalRelay()
        operator = _FakeWS([
            {"type": "websocket.receive", "text": '{"t":"resize","cols":120,"rows":40}'},
        ])
        await r.attach_operator("s1", operator)
        await r.pump("s1", operator, is_operator=True)

        agent = _FakeWS()
        await r.attach_agent("s1", agent)
        return agent.sent_text, r._pairs["s1"].pending_to_agent

    sent_text, remaining = asyncio.run(scenario())
    assert sent_text == ['{"t":"resize","cols":120,"rows":40}']
    assert remaining == [], "the buffer must be cleared once replayed"


def test_pending_buffer_is_bounded():
    """A client that keeps typing at a wall must not grow this without limit."""
    async def scenario():
        r = TerminalRelay()
        messages = [
            {"type": "websocket.receive", "bytes": bytes([i % 256])}
            for i in range(relay_module._MAX_PENDING_FRAMES + 50)
        ]
        operator = _FakeWS(messages)
        await r.attach_operator("s1", operator)
        await r.pump("s1", operator, is_operator=True)
        return len(r._pairs["s1"].pending_to_agent)

    assert asyncio.run(scenario()) == relay_module._MAX_PENDING_FRAMES


def test_a_closed_pair_still_stops_the_pump():
    """Buffering must not defeat teardown: a closed session ends immediately."""
    async def scenario():
        r = TerminalRelay()
        operator = _FakeWS([
            {"type": "websocket.receive", "bytes": b"a"},
            {"type": "websocket.receive", "bytes": b"b"},
        ])
        await r.attach_operator("s1", operator)
        r._pairs["s1"].closed = True
        await r.pump("s1", operator, is_operator=True)
        return r._pairs["s1"].pending_to_agent

    assert asyncio.run(scenario()) == [], "a closed pair must buffer nothing"


def test_agent_frames_before_the_operator_are_not_buffered():
    """Only the operator-first ordering is real; an agent that somehow arrives
    alone must not accumulate output for a browser that may never come."""
    async def scenario():
        r = TerminalRelay()
        agent = _FakeWS([{"type": "websocket.receive", "bytes": b"motd"}])
        await r.attach_agent("s1", agent)
        await r.pump("s1", agent, is_operator=False)
        return r._pairs["s1"].pending_to_agent

    assert asyncio.run(scenario()) == []
