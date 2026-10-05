import asyncio
import logging
from contextlib import suppress

from app.core.config import settings
from app.db.session import SessionLocal
from app.services.device_status_service import DeviceStatusService
from app.core import worker_health

logger = logging.getLogger(__name__)


class DeviceReconciliationWorker:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="device-reconciliation-worker")
        worker_health.register("reconcile", "reconcile", settings.RECONCILIATION_INTERVAL_SECONDS,
                               lambda: self._task is not None and not self._task.done())
        logger.info("Device reconciliation worker started")

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        self._task.cancel()
        with suppress(asyncio.CancelledError):
            await self._task
        logger.info("Device reconciliation worker stopped")

    async def run_once(self) -> int:
        return await asyncio.to_thread(self._run_once_sync)

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                transitioned = await self.run_once()
                if transitioned:
                    logger.info("Reconciled %s stale device statuses", transitioned)
            except Exception:
                logger.exception("Device reconciliation pass failed")
            worker_health.beat("reconcile")

            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=settings.RECONCILIATION_INTERVAL_SECONDS,
                )
            except asyncio.TimeoutError:
                continue

    @staticmethod
    def _run_once_sync() -> int:
        db = SessionLocal()
        try:
            service = DeviceStatusService(db)
            return service.reconcile_stale_devices()
        finally:
            db.close()


device_reconciliation_worker = DeviceReconciliationWorker()
