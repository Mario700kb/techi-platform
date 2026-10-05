"""Notification retry sweep — same start/stop pattern as
device_reconciliation_worker / terminal_watchdog.

Picks up NotificationDelivery rows in RETRYING status whose next_retry_at
has passed and re-attempts them via the same send path dispatch() uses.
Only started when FEATURE_NOTIFICATIONS is enabled (see main.py) — flag-off
stays zero-extra-behavior, no new periodic queries.
"""

import asyncio
import logging
from contextlib import suppress

from app.db.session import SessionLocal
from app.services.notification_service import NotificationService
from app.core import worker_health

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 60


class NotificationWorker:
    def __init__(self) -> None:
        self._task: "asyncio.Task | None" = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="notification-worker")
        worker_health.register("notifications", "alerts", SWEEP_INTERVAL_SECONDS,
                               lambda: self._task is not None and not self._task.done())
        logger.info("Notification worker started")

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        self._task.cancel()
        with suppress(asyncio.CancelledError):
            await self._task
        logger.info("Notification worker stopped")

    async def run_once(self) -> int:
        """One sweep pass. Returns the number of deliveries attempted."""
        db = SessionLocal()
        attempted = 0
        try:
            svc = NotificationService(db)
            due = svc.deliveries.due_for_retry()
            for delivery in due:
                svc.retry_delivery(delivery)
                attempted += 1
        except Exception:
            logger.exception("Notification retry sweep failed")
        finally:
            db.close()
        return attempted

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                attempted = await self.run_once()
                if attempted:
                    logger.info("Notification worker retried %s delivery(ies)", attempted)
            except Exception:
                logger.exception("Notification worker pass failed")
            worker_health.beat("notifications")

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=SWEEP_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                continue


notification_worker = NotificationWorker()
