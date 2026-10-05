"""Scheduled Reporting worker.

Uses the same in-process lifecycle pattern as NotificationWorker and
TerminalWatchdog. The scheduler is flag-gated and single-worker-safe under the
current production architecture; moving workers out-of-process remains part of
the documented horizontal-scaling work.
"""

import asyncio
import logging
import time

from app.core.time import utcnow
from app.db.session import SessionLocal
from app.repositories.report_repository import ReportScheduleRepository
from app.services.audit_service import system_audit_log
from app.services.report_service import ReportService, next_schedule_time

logger = logging.getLogger(__name__)


class ReportWorker:
    SWEEP_SECONDS = 60

    def __init__(self):
        self._task = None
        self._stop = None
        self._last_cleanup_monotonic = 0.0

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="report-worker")
        logger.info("ReportWorker started")

    async def stop(self) -> None:
        if self._task is None:
            return
        if self._stop is not None:
            self._stop.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.run_once)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("ReportWorker sweep failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.SWEEP_SECONDS)
                return
            except asyncio.TimeoutError:
                pass

    def run_once(self) -> int:
        db = SessionLocal()
        generated = 0
        try:
            now = utcnow()
            schedules = ReportScheduleRepository(db).list_due(now)
            for schedule in schedules:
                # Advance first so a generation failure never creates a tight
                # retry loop every minute. The failed run stays visible.
                schedule = ReportScheduleRepository(db).update(
                    schedule,
                    next_run_at=next_schedule_time(
                        schedule.cadence,
                        hour_local=schedule.hour_local,
                        day_of_week=schedule.day_of_week,
                        day_of_month=schedule.day_of_month,
                        after=now,
                    ),
                    last_run_at=now,
                )
                try:
                    run = ReportService(db).generate(
                        client_id=schedule.client_id,
                        report_format=schedule.report_format,
                        period_days=schedule.period_days,
                        generated_by="system",
                        schedule_id=schedule.id,
                        period_end=now,
                    )
                    system_audit_log(
                        db, action="report_generated", entity_type="report_run", entity_id=run.id,
                        details={"client_id": run.client_id, "schedule_id": schedule.id, "format": run.report_format},
                    )
                    generated += 1
                except Exception:
                    logger.exception("Scheduled report failed schedule=%s", schedule.id)
                    system_audit_log(
                        db, action="report_generation_failed", entity_type="report_schedule", entity_id=schedule.id,
                        details={"client_id": schedule.client_id, "format": schedule.report_format},
                    )
            monotonic = time.monotonic()
            if monotonic - self._last_cleanup_monotonic >= 86400:
                ReportService(db).cleanup_expired()
                self._last_cleanup_monotonic = monotonic
            return generated
        finally:
            db.close()


report_worker = ReportWorker()
