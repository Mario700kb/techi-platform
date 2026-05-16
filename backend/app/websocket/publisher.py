import asyncio
import logging
import time
from typing import Any, Dict, Optional

from app.websocket.manager import realtime_manager

logger = logging.getLogger(__name__)


class RealtimeEventPublisher:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[Dict[str, Any]] | None = None
        self._task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._recent_events: Dict[str, float] = {}
        self._dedupe_ttl_seconds = 0.75

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=1000)
        self._task = asyncio.create_task(self._run(), name="realtime-event-publisher")
        logger.info("Realtime event publisher started")

    async def stop(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self._queue = None
        logger.info("Realtime event publisher stopped")

    async def publish(self, event: Dict[str, Any], *, dedupe_key: Optional[str] = None) -> None:
        if dedupe_key and self._is_duplicate(dedupe_key):
            logger.debug("Skipped duplicate realtime event: %s", dedupe_key)
            return
        if self._queue is None:
            logger.debug("Realtime publisher not started; dropping event type=%s", event.get("type"))
            return
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("Realtime event queue full; dropping event type=%s", event.get("type"))

    def publish_threadsafe(self, event: Dict[str, Any], *, dedupe_key: Optional[str] = None) -> None:
        if self._loop is None or self._loop.is_closed():
            logger.debug("Realtime publisher loop not available; dropping event type=%s", event.get("type"))
            return
        future = asyncio.run_coroutine_threadsafe(self.publish(event, dedupe_key=dedupe_key), self._loop)
        future.add_done_callback(self._log_publish_error)

    async def _run(self) -> None:
        assert self._queue is not None
        while True:
            event = await self._queue.get()
            try:
                await realtime_manager.broadcast(event)
            except Exception:
                logger.exception("Realtime event broadcast failed")
            finally:
                self._queue.task_done()

    def _is_duplicate(self, dedupe_key: str) -> bool:
        now = time.monotonic()
        self._recent_events = {
            key: seen_at
            for key, seen_at in self._recent_events.items()
            if now - seen_at < self._dedupe_ttl_seconds
        }
        if dedupe_key in self._recent_events:
            return True
        self._recent_events[dedupe_key] = now
        return False

    @staticmethod
    def _log_publish_error(future: asyncio.Future) -> None:
        try:
            future.result()
        except Exception:
            logger.exception("Realtime event publish failed")


realtime_publisher = RealtimeEventPublisher()
