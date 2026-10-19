"""Overload protection for agent heartbeats, and request metrics.

2026-10-19 16:06–16:18: after a restart the backend fell behind, agents gave
up after their 10 s timeout and sent the same heartbeat twice more, and the
backend kept working for agents that had already left — 340–400 heartbeats a
minute instead of ~120 — until a restart threw the queue away. Nothing
limited how much heartbeat work could pile up.

HeartbeatGuard answers before any thread or database work:
- 503 + Retry-After when HEARTBEAT_MAX_IN_FLIGHT heartbeats are already being
  handled (side effects included: they run inside the same request), so the
  queue stays shorter than the agents' timeout;
- 503 for a heartbeat of an agent whose previous one is still being handled
  (the agent's own retry).
Any agent version ends its cycle on a non-2xx and tries again later, so
shedding costs one heartbeat, never a device.

RequestMetrics logs every request slower than SLOW_REQUEST_S, and once a
minute one line: requests, 5xx, p95, slowest, shed heartbeats and the most
heartbeats in flight.
"""
from __future__ import annotations

import logging
import random
import re
import time
from collections import Counter
from typing import Optional

from app.core.config import settings

logger = logging.getLogger("techi.load")

HEARTBEAT_PATHS = frozenset({"/api/v1/agent/heartbeat", "/api/heartbeat"})
# A heartbeat that has waited this long is answered without its pending
# actions: the agent stops listening at 10 s, and an action marked SENT for an
# agent that never read the reply would be lost.
DELIVERY_DEADLINE_S = 8.0
SLOW_REQUEST_S = 2.0

_AGENT_ID = re.compile(rb'"agent_id"\s*:\s*"([^"\\]{1,128})"')
_DEVICE_ID = re.compile(rb'"device_id"\s*:\s*(\d{1,12})')


def heartbeat_age(request) -> float:
    """Seconds since the guard accepted this heartbeat (0 when not guarded)."""
    arrived = getattr(request.state, "heartbeat_arrived", None)
    return time.monotonic() - arrived if arrived else 0.0


class HeartbeatLoad:
    """Heartbeats being handled now, shared by the guard and the metrics line
    (Starlette builds middleware instances itself, so they cannot be wired)."""

    def __init__(self) -> None:
        self.in_flight = 0
        self.peak = 0
        self.agents: set[bytes] = set()
        self.shed: Counter = Counter()

    def take_stats(self) -> dict:
        stats = {"shed_busy": self.shed["busy"], "shed_duplicate": self.shed["duplicate"], "peak_in_flight": self.peak}
        self.shed.clear()
        self.peak = self.in_flight
        return stats


heartbeat_load = HeartbeatLoad()


class HeartbeatGuard:
    def __init__(self, app, max_in_flight: Optional[int] = None, load: Optional[HeartbeatLoad] = None):
        self.app = app
        self.max_in_flight = max_in_flight or settings.HEARTBEAT_MAX_IN_FLIGHT
        self.load = load or heartbeat_load

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST" or scope.get("path") not in HEARTBEAT_PATHS:
            return await self.app(scope, receive, send)
        load = self.load
        if load.in_flight >= self.max_in_flight:
            return await self._shed(send, "busy")

        chunks = []
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return  # the client went away before sending its body
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        body = b"".join(chunks)

        key = _agent_key(body)
        if key is not None and key in load.agents:
            return await self._shed(send, "duplicate")

        load.in_flight += 1
        load.peak = max(load.peak, load.in_flight)
        if key is not None:
            load.agents.add(key)
        scope.setdefault("state", {})["heartbeat_arrived"] = time.monotonic()
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        try:
            await self.app(scope, replay, send)
        finally:
            load.in_flight -= 1
            if key is not None:
                load.agents.discard(key)

    async def _shed(self, send, reason: str) -> None:
        self.load.shed[reason] += 1
        body = b'{"detail":"Server busy, try again later"}'
        await send({
            "type": "http.response.start",
            "status": 503,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                # Spread the retries; agents up to 2.1.33 ignore it and come
                # back with their next scheduled heartbeat.
                (b"retry-after", str(random.randint(30, 90)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})


def _agent_key(body: bytes) -> Optional[bytes]:
    match = _AGENT_ID.search(body)
    if match:
        return b"a:" + match.group(1)
    match = _DEVICE_ID.search(body)
    return b"d:" + match.group(1) if match else None


class RequestMetrics:
    """Inside HeartbeatGuard: shed heartbeats are counted there, not as 5xx."""

    def __init__(self, app, window_s: float = 60.0, load: Optional[HeartbeatLoad] = None):
        self.app = app
        self.load = load or heartbeat_load
        self.window_s = window_s
        self._reset(time.monotonic())

    def _reset(self, now: float) -> None:
        self.window_start = now
        self.durations: list[float] = []
        self.errors = 0
        self.slowest = (0.0, "")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = time.monotonic()
        status = 500
        recorded = False

        async def timed_send(message):
            nonlocal status, recorded
            if message["type"] == "http.response.start":
                status = message["status"]
            elif message["type"] == "http.response.body" and not message.get("more_body") and not recorded:
                recorded = True
                self._record(scope, status, time.monotonic() - started)
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        finally:
            if not recorded:
                self._record(scope, status, time.monotonic() - started)

    def _record(self, scope, status: int, elapsed: float) -> None:
        path = scope.get("path", "")
        if elapsed >= SLOW_REQUEST_S:
            logger.warning("slow request %s %s -> %s in %.1f s", scope.get("method"), path, status, elapsed)
        self.durations.append(elapsed)
        if status >= 500:
            self.errors += 1
        if elapsed > self.slowest[0]:
            self.slowest = (elapsed, path)
        now = time.monotonic()
        if now - self.window_start >= self.window_s:
            self._flush(now)

    def _flush(self, now: float) -> None:
        durations = sorted(self.durations)
        p95 = durations[int(len(durations) * 0.95) - 1] if len(durations) >= 20 else (durations[-1] if durations else 0.0)
        guard = self.load.take_stats()
        logger.info(
            "load: %d requests, %d 5xx, p95 %.2f s, slowest %.2f s %s, heartbeats shed %d busy / %d duplicate, "
            "peak in flight %d",
            len(durations), self.errors, p95, self.slowest[0], self.slowest[1],
            guard.get("shed_busy", 0), guard.get("shed_duplicate", 0), guard.get("peak_in_flight", 0),
        )
        self._reset(now)
