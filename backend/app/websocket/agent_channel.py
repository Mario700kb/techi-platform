"""Agent command channel — a persistent outbound WebSocket per agent.

Why this exists
---------------
Remote actions reach an agent only inside its heartbeat response. That is fine
for maintenance work, but it makes anything interactive unusable: opening a Web
Terminal on the Linux endpoint took ~200s, because the agent did not learn a
session existed until its next heartbeat (2026-08-04, device 729 — the operator
gave up and the session closed with reason=operator_closed every time).

Shortening the interval only trades latency for load. The right fix is the
model RustDesk already uses: the agent keeps one outbound connection open and
the server pushes on it. The agent still dials out over 443, so this adds no
listening port, no inbound rule and no NAT requirement — the property that
makes the agent transport work at all is preserved exactly.

Deliberately narrow
-------------------
- Push is best-effort. Actions are still queued in the database first, so an
  agent that is not connected is served by the heartbeat path exactly as
  before. This channel only ever makes delivery *sooner*, never necessary.
- Registration requires the caller to prove it knows the device's `agent_id`
  (144 bits, secrets.token_urlsafe(18)), the same knowledge barrier the
  heartbeat response gate uses. See RISK-SEC-002.
- One connection per device. A reconnect replaces the previous entry so a
  half-dead socket cannot shadow a live one.
"""

import asyncio
import logging
from typing import Any, Dict, Optional

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class AgentCommandChannel:
    def __init__(self) -> None:
        self._connections: Dict[int, WebSocket] = {}
        self._lock = asyncio.Lock()

    async def register(self, device_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            previous = self._connections.get(device_id)
            self._connections[device_id] = websocket
        if previous is not None and previous is not websocket:
            # A reconnect before the old socket was reaped. Drop the stale one
            # rather than leaving two entries racing to receive a push.
            try:
                await previous.close()
            except Exception:
                pass
            logger.info("[agent-channel] device #%d reconnected, replaced stale connection", device_id)
        else:
            logger.info("[agent-channel] device #%d connected", device_id)

    async def unregister(self, device_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            # Only clear if this is still the current socket: a slow disconnect
            # must not evict the connection that already replaced it.
            if self._connections.get(device_id) is websocket:
                self._connections.pop(device_id, None)
                logger.info("[agent-channel] device #%d disconnected", device_id)

    def is_connected(self, device_id: int) -> bool:
        return device_id in self._connections

    async def push(self, device_id: int, payload: Dict[str, Any]) -> bool:
        """Send to a connected agent. Returns False if it was not delivered.

        Never raises: the caller has already persisted the action, and a push
        failure must degrade to the heartbeat path rather than fail the request.
        """
        websocket: Optional[WebSocket] = self._connections.get(device_id)
        if websocket is None:
            return False
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            logger.info("[agent-channel] push to device #%d failed; falling back to heartbeat", device_id)
            async with self._lock:
                if self._connections.get(device_id) is websocket:
                    self._connections.pop(device_id, None)
            return False

    async def connection_count(self) -> int:
        return len(self._connections)


agent_command_channel = AgentCommandChannel()
