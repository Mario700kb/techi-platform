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
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class AgentCommandChannel:
    def __init__(self) -> None:
        self._connections: Dict[int, WebSocket] = {}
        # Devices whose channel dropped and whose grace period is still
        # running: when it dropped. The page shows them as "reconnecting"
        # until the channel returns or the grace decides.
        self._lost_at: Dict[int, datetime] = {}
        # Sockets a failed push removed, until their own teardown runs.
        self._evicted: Dict[int, WebSocket] = {}
        self._lock = asyncio.Lock()
        # Set while the backend shuts down: every channel drops then, and none
        # of those drops means a device went offline.
        self.presence_paused = False

    async def register(self, device_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            previous = self._connections.get(device_id)
            self._connections[device_id] = websocket
            self._lost_at.pop(device_id, None)
            self._evicted.pop(device_id, None)
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

    async def unregister(self, device_id: int, websocket: WebSocket) -> bool:
        """Returns True when this socket was the device's channel until now
        (current, or evicted by a failed push), so the device has none now."""
        async with self._lock:
            # Only clear if this is still the current socket: a slow disconnect
            # must not evict the connection that already replaced it.
            if self._connections.get(device_id) is websocket:
                self._connections.pop(device_id, None)
                logger.info("[agent-channel] device #%d disconnected", device_id)
                return True
            # A failed push already evicted this socket: the device has had
            # no channel since, and its drop still needs the grace check.
            if self._evicted.pop(device_id, None) is websocket:
                return True
        return False

    def is_connected(self, device_id: int) -> bool:
        return device_id in self._connections

    def connected_ids(self) -> List[int]:
        """The devices with an open channel now: live, so online."""
        return list(self._connections)

    def note_lost(self, device_id: int, at: datetime) -> None:
        self._lost_at[device_id] = at

    def lost_since(self, device_id: int) -> Optional[datetime]:
        """When the device's channel dropped, while its grace period runs."""
        return self._lost_at.get(device_id)

    def clear_lost(self, device_id: int, at: Optional[datetime] = None) -> None:
        """End the reconnecting state; with `at`, only the drop recorded then
        (a later drop has its own grace period)."""
        if at is None or self._lost_at.get(device_id) == at:
            self._lost_at.pop(device_id, None)

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
                    self._evicted[device_id] = websocket
            return False

    async def close_device(self, device_id: int) -> bool:
        """Close a device's channel (its agent was revoked). The agent's
        reconnect is then refused at the handshake."""
        websocket: Optional[WebSocket] = self._connections.get(device_id)
        if websocket is None:
            return False
        try:
            await websocket.close(code=4003)
        except Exception:
            pass
        return True

    async def connection_count(self) -> int:
        return len(self._connections)


agent_command_channel = AgentCommandChannel()


# The event loop the application runs on.
#
# Sync endpoints (`def`, not `async def`) are executed by FastAPI in a worker
# thread, where `asyncio.get_running_loop()` raises RuntimeError. A push from
# such an endpoint therefore has to be handed to the main loop explicitly via
# `run_coroutine_threadsafe`. Captured once at startup because there is exactly
# one loop for the process's lifetime.
#
# This is not a detail: not capturing it is what broke terminal delivery on
# 2026-08-05 — the push raised, the action had already been marked SENT, and
# the heartbeat path (which only collects QUEUED work) never saw it again.
_main_loop: Optional[asyncio.AbstractEventLoop] = None


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


def get_main_loop() -> Optional[asyncio.AbstractEventLoop]:
    return _main_loop
