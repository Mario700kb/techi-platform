"""In-memory Web Terminal relay (Platform Expansion Phase 5).

Pairs the operator WebSocket with the agent WebSocket for a session and pumps
bytes between them. Per-process and in-memory — correct for the single-worker
backend today; if the terminal is ever enabled at fleet scale this is the piece
that moves out-of-process (audit R5), without changing the wire protocol.

Isolated: touches nothing except its own session registry.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import WebSocket


@dataclass
class _Pair:
    operator: Optional[WebSocket] = None
    agent: Optional[WebSocket] = None
    both_attached: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False


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
        if pair.agent is not None:
            pair.both_attached.set()
        return pair

    async def attach_agent(self, session_id: str, ws: WebSocket) -> _Pair:
        pair = await self._pair(session_id)
        pair.agent = ws
        if pair.operator is not None:
            pair.both_attached.set()
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


terminal_relay = TerminalRelay()
