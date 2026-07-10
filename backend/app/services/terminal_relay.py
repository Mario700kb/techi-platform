"""In-memory Web Terminal relay (Platform Expansion Phase 5).

Pairs the operator WebSocket with the agent WebSocket for a session and pumps
bytes between them. Per-process and in-memory — correct for the single-worker
backend today; if the terminal is ever enabled at fleet scale this is the piece
that moves out-of-process (audit R5), without changing the wire protocol.

Isolated: touches nothing except its own session registry — no DB, no audit.
`idle_and_expired_sessions()` exposes a read-only snapshot so a separate
watchdog (app.workers.terminal_watchdog) can decide what to force-close and
handle the DB/audit side effects; this keeps the relay a pure transport.
"""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import WebSocket


@dataclass
class _Pair:
    operator: Optional[WebSocket] = None
    agent: Optional[WebSocket] = None
    both_attached: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False
    started_monotonic: Optional[float] = None      # set once both sides attach
    last_activity_monotonic: float = field(default_factory=time.monotonic)


class TerminalRelay:
    def __init__(self) -> None:
        self._pairs: Dict[str, _Pair] = {}
        self._lock = asyncio.Lock()

    async def _pair(self, session_id: str) -> _Pair:
        async with self._lock:
            return self._pairs.setdefault(session_id, _Pair())

    async def attach_operator(self, session_id: str, ws: WebSocket) -> _Pair:
        pair = await self._pair(session_id)
        pair.operator = ws
        pair.last_activity_monotonic = time.monotonic()
        if pair.agent is not None:
            pair.both_attached.set()
            pair.started_monotonic = pair.started_monotonic or time.monotonic()
        return pair

    async def attach_agent(self, session_id: str, ws: WebSocket) -> _Pair:
        pair = await self._pair(session_id)
        pair.agent = ws
        pair.last_activity_monotonic = time.monotonic()
        if pair.operator is not None:
            pair.both_attached.set()
            pair.started_monotonic = pair.started_monotonic or time.monotonic()
        return pair

    def is_active(self, session_id: str) -> bool:
        pair = self._pairs.get(session_id)
        return bool(pair and pair.operator and pair.agent and not pair.closed)

    async def pump(self, session_id: str, source: WebSocket, is_operator: bool) -> None:
        """Forward frames from `source` to the counterpart until either side
        closes. Binary-safe: both text and bytes frames are relayed as-is."""
        pair = self._pairs.get(session_id)
        if pair is None:
            return
        try:
            while True:
                message = await source.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                target = pair.agent if is_operator else pair.operator
                if target is None or pair.closed:
                    break
                pair.last_activity_monotonic = time.monotonic()
                if message.get("bytes") is not None:
                    await target.send_bytes(message["bytes"])
                elif message.get("text") is not None:
                    await target.send_text(message["text"])
        except Exception:
            pass

    async def close(self, session_id: str) -> None:
        async with self._lock:
            pair = self._pairs.pop(session_id, None)
        if pair is None:
            return
        pair.closed = True
        for ws in (pair.operator, pair.agent):
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass

    def idle_and_expired_sessions(self, idle_timeout_seconds: float, max_session_seconds: float) -> Dict[str, str]:
        """Read-only snapshot: session_id -> reason ("idle_timeout" |
        "max_duration") for live pairs a watchdog should force-close.
        Never mutates state — callers close via `close()` and update the DB."""
        now = time.monotonic()
        violations: Dict[str, str] = {}
        for session_id, pair in list(self._pairs.items()):
            if pair.closed:
                continue
            if pair.started_monotonic is not None and (now - pair.started_monotonic) >= max_session_seconds:
                violations[session_id] = "max_duration"
                continue
            if (now - pair.last_activity_monotonic) >= idle_timeout_seconds:
                violations[session_id] = "idle_timeout"
        return violations


terminal_relay = TerminalRelay()
