"""Web Terminal cleanup sweep (Platform Expansion Phase 5).

Same start/stop pattern as device_reconciliation_worker. Two jobs, both
idempotent and safe to run repeatedly:

1. Expire PENDING sessions whose ticket TTL passed without both sides
   attaching (TerminalService.expire_stale — DB only).
2. Force-close ACTIVE relay pairs that exceed the idle timeout or the hard
   session cap (terminal_relay.idle_and_expired_sessions — read-only
   snapshot; this worker owns the side effects: closing the relay pair,
   marking the DB session closed, and writing the audit entry).

Together these guarantee a forgotten browser tab, a wedged agent connection,
or a crashed relay pair can never leak an orphan session/PTY/websocket
indefinitely. Only started when FEATURE_TERMINAL is enabled (see main.py) —
with the flag off this task never runs, so flag-off behavior stays
unaffected (no new periodic queries).
"""

import asyncio
import logging
from contextlib import suppress

from app.db.session import SessionLocal
from app.services.audit_service import AuditAction, system_audit_log
from app.services.terminal_relay import terminal_relay
from app.services.terminal_service import IDLE_TIMEOUT_SECONDS, SESSION_MAX_SECONDS, TerminalService
from app.core import worker_health

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 30


class TerminalWatchdog:
    def __init__(self) -> None:
        self._task: "asyncio.Task | None" = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="terminal-watchdog")
        worker_health.register("terminal", "terminal", SWEEP_INTERVAL_SECONDS,
                               lambda: self._task is not None and not self._task.done())
        logger.info("Terminal watchdog started")

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        self._task.cancel()
        with suppress(asyncio.CancelledError):
            await self._task
        logger.info("Terminal watchdog stopped")

    async def run_once(self) -> int:
        """One sweep pass. Returns the number of sessions closed/expired."""
        closed = 0
        db = SessionLocal()
        try:
            svc = TerminalService(db)

            expired = svc.expire_stale()
            if expired:
                system_audit_log(
                    db,
                    action=AuditAction.TERMINAL_SESSION_EXPIRED,
                    entity_type="terminal_session",
                    details={"count": expired},
                )
                closed += expired

            violations = terminal_relay.idle_and_expired_sessions(IDLE_TIMEOUT_SECONDS, SESSION_MAX_SECONDS)
            for session_id, reason in violations.items():
                await terminal_relay.close(session_id)
                session = svc.get(session_id)
                if session is None:
                    continue
                svc.close(session, reason)
                system_audit_log(
                    db,
                    action=AuditAction.TERMINAL_SESSION_CLOSED,
                    entity_type="terminal_session",
                    entity_id=None,
                    details={
                        "session_id": session_id,
                        "device_id": session.device_id,
                        "operator_username": session.operator_username,
                        "reason": reason,
                        "duration_seconds": session.duration_seconds,
                    },
                )
                closed += 1
        except Exception:
            logger.exception("Terminal watchdog sweep failed")
        finally:
            db.close()
        return closed

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                closed = await self.run_once()
                if closed:
                    logger.info("Terminal watchdog closed/expired %s session(s)", closed)
            except Exception:
                logger.exception("Terminal watchdog pass failed")
            worker_health.beat("terminal")

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=SWEEP_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                continue


terminal_watchdog = TerminalWatchdog()
