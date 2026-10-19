import asyncio
import time
from contextlib import asynccontextmanager
from datetime import timedelta
import logging
import os

from sqlalchemy.engine import make_url

from app.core.logging_config import configure_logging
from app.core.request_context import ClientIPMiddleware

configure_logging()

from fastapi import Depends, FastAPI, Request
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from app.api.legacy_compat import router as legacy_compat_router
from app.api.rustdesk_audit import router as rustdesk_audit_router
from app.api.v1.api import api_router
from app.api.v1.endpoints.agent import agent_enroll
from app.core.auth import require_min_role
from app.core.config import settings
from app.models.operator import OperatorRole
from app.db.session import engine, get_db
from app.schemas.agent import AgentEnrollmentRequest
from app.services.schema_compat_service import ensure_sqlite_dev_schema
from app.services.auth_service import ensure_bootstrap_owner
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.ssh_connector import ssh_connector_runner
from app.platform_core.flags import feature_enabled
from app.websocket.publisher import realtime_publisher
from app.websocket.routes import router as websocket_router
from app.workers.device_reconciliation_worker import device_reconciliation_worker
from app.workers.notification_worker import notification_worker
from app.workers.report_worker import report_worker
from app.workers.terminal_watchdog import terminal_watchdog
from app.core.time import utcnow_naive

logger = logging.getLogger("techi.startup")


def _run_heartbeat_cleanup() -> None:
    # Bulk DELETEs and VACUUM run longer than a request is allowed to.
    from app.db.session import MaintenanceSessionLocal as SessionLocal
    from app.tasks.cleanup import (
        cleanup_old_heartbeats,
        cleanup_old_telemetry,
        cleanup_old_activity_events,
        cleanup_resolved_alerts,
        cleanup_old_remote_actions,
        cleanup_old_command_batches,
        cleanup_old_status_history,
        cleanup_old_audit_logs,
        cleanup_old_enrollment_audit,
        cleanup_old_remote_support_connections,
        purge_trashed_devices,
        resolve_stale_alerts,
        rotate_remote_support_passwords,
    )
    from app.services.telemetry_ingest_service import cleanup_telemetry_pipeline
    from app.services.terminal_recording import cleanup_recordings

    def cleanup_terminal_recordings(_db) -> int:
        return cleanup_recordings()

    tasks = (
        purge_trashed_devices,
        resolve_stale_alerts,
        rotate_remote_support_passwords,
        cleanup_old_heartbeats,
        cleanup_old_telemetry,
        cleanup_old_activity_events,
        cleanup_resolved_alerts,
        cleanup_old_remote_actions,
        cleanup_old_command_batches,
        cleanup_old_status_history,
        cleanup_old_audit_logs,
        cleanup_old_enrollment_audit,
        cleanup_old_remote_support_connections,
        cleanup_telemetry_pipeline,
        cleanup_terminal_recordings,
    )
    from app.core import worker_health
    from app.services.audit_service import system_audit_log

    db = SessionLocal()
    worker_health.cleanup_started()
    started = time.monotonic()
    rows = 0
    failed = []
    try:
        # Each task commits/vacuums independently; one failure must not stop the rest.
        for task in tasks:
            try:
                rows += int(task(db) or 0)
            except Exception:
                db.rollback()
                failed.append(task.__name__)
                logger.exception("Cleanup task %s failed", task.__name__)
        # Durable record for the System status panel (survives restarts).
        system_audit_log(db, action="nightly_cleanup", details={
            "rows_deleted": rows,
            "failed_tasks": failed,
            "duration_seconds": round(time.monotonic() - started, 1),
        })
    finally:
        worker_health.cleanup_finished()
        db.close()


async def _heartbeat_cleanup_scheduler() -> None:
    while True:
        now = utcnow_naive()
        next_03 = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if next_03 <= now:
            next_03 += timedelta(days=1)
        delay = (next_03 - now).total_seconds()
        logger.info("Next heartbeat cleanup at %s UTC (in %.0fs)", next_03.isoformat(), delay)
        await asyncio.sleep(delay)
        await asyncio.to_thread(_run_heartbeat_cleanup)


# Client locations: new devices and changed addresses reach their site
# without anyone pressing Re-apply. Light (only clients that have locations,
# ~150 devices each), and first run after the restart's heartbeat surge.
LOCATION_SWEEP_FIRST_DELAY_S = 120
LOCATION_SWEEP_INTERVAL_S = 900


def _run_location_sweep() -> None:
    from app.db.session import SessionLocal
    from app.services.location_service import sweep_location_rules

    db = SessionLocal()
    try:
        result = sweep_location_rules(db)
        if result.assigned or result.cleared:
            logger.info("Location rules: %d placed, %d cleared", result.assigned, result.cleared)
    except Exception:
        logger.exception("Location rule sweep failed")
        db.rollback()
    finally:
        db.close()


MONITOR_SWEEP_INTERVAL_S = 300


def _run_monitor_sweep() -> None:
    """Server-side monitors (telemetry not arriving, disks that will fill);
    the agent evaluates the rest on the device."""
    from app.db.session import SessionLocal
    from app.services.monitor_alert_service import MonitorAlertService

    db = SessionLocal()
    try:
        MonitorAlertService(db).sweep()
    except Exception:
        logger.exception("Monitor sweep failed")
        db.rollback()
    finally:
        db.close()


async def _monitor_sweep_scheduler() -> None:
    await asyncio.sleep(90)
    while True:
        await asyncio.to_thread(_run_monitor_sweep)
        await asyncio.sleep(MONITOR_SWEEP_INTERVAL_S)


def _ensure_telemetry_partitions() -> None:
    from app.db.session import SessionLocal
    from app.services.telemetry_ingest_service import ensure_partitions

    db = SessionLocal()
    try:
        ensure_partitions(db)
    except Exception:
        logger.exception("Telemetry partitions could not be checked")
        db.rollback()
    finally:
        db.close()


async def _location_sweep_scheduler() -> None:
    await asyncio.sleep(LOCATION_SWEEP_FIRST_DELAY_S)
    while True:
        await asyncio.to_thread(_run_location_sweep)
        await asyncio.sleep(LOCATION_SWEEP_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s v%s [env=%s]", settings.PROJECT_NAME, settings.PROJECT_VERSION, settings.ENVIRONMENT)
    if settings.BACKEND_CORS_ALLOW_ALL:
        logger.warning("CORS: allow_all=true — all origins permitted (LAN/dev mode only)")
    else:
        logger.info("CORS origins: %s", settings.BACKEND_CORS_ORIGINS)
    logger.info("Database: %s", make_url(settings.DATABASE_URL).render_as_string(hide_password=True))

    if settings.ENVIRONMENT != "development" and not settings.BOOTSTRAP_OWNER_PASSWORD:
        logger.warning("BOOTSTRAP_OWNER_PASSWORD is not set — bootstrap owner will use a random password")

    pkg_dir = settings.AGENT_PACKAGE_STORAGE_DIR
    if pkg_dir and not os.path.isdir(pkg_dir):
        logger.warning("AGENT_PACKAGE_STORAGE_DIR does not exist or is not accessible: %s", pkg_dir)

    # Sync endpoints run in a worker thread with no running loop of their own,
    # so anything that needs to reach the agent command channel from one has to
    # schedule onto this loop explicitly. See agent_channel.set_main_loop.
    import asyncio as _asyncio

    from app.websocket.agent_channel import set_main_loop

    set_main_loop(_asyncio.get_running_loop())

    ensure_sqlite_dev_schema(engine)
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        ensure_bootstrap_owner(db)
        EnrollmentTokenService(db).ensure_default_token(
            enabled=settings.DEFAULT_DEPLOYMENT_TOKEN_ENABLED,
            max_uses=settings.DEFAULT_DEPLOYMENT_TOKEN_MAX_USES,
            expires_days=settings.DEFAULT_DEPLOYMENT_TOKEN_EXPIRES_DAYS,
        )
    finally:
        db.close()

    realtime_publisher.start()
    device_reconciliation_worker.start()
    cleanup_task = asyncio.create_task(_heartbeat_cleanup_scheduler())
    location_sweep_task = asyncio.create_task(_location_sweep_scheduler())
    await asyncio.to_thread(_ensure_telemetry_partitions)
    monitor_sweep_task = asyncio.create_task(_monitor_sweep_scheduler())
    # Only runs when the feature is actually reachable — flag OFF stays
    # zero-extra-behavior (no new periodic queries).
    if feature_enabled("FEATURE_TERMINAL"):
        terminal_watchdog.start()
        ssh_connector_runner.start()
    if feature_enabled("FEATURE_NOTIFICATIONS"):
        notification_worker.start()
    if feature_enabled("FEATURE_REPORTING"):
        report_worker.start()

    # Build the dashboard read models in the background so the first visit
    # after a restart does not wait on them.
    from app.services.device_overview_service import warm_overview_cache
    from app.services.fleet_insights_service import warm_insights_cache

    warm_db = SessionLocal()
    try:
        warm_overview_cache(warm_db)
        warm_insights_cache(warm_db)
    finally:
        warm_db.close()

    yield
    # Channels close with the process; none of that means a device went offline.
    from app.websocket.agent_channel_routes import cancel_presence_checks

    cancel_presence_checks()

    for task in (cleanup_task, location_sweep_task, monitor_sweep_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await terminal_watchdog.stop()
    ssh_connector_runner.stop()
    await notification_worker.stop()
    await report_worker.stop()
    await device_reconciliation_worker.stop()
    await realtime_publisher.stop()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.PROJECT_VERSION,
    # The API description is served below to signed-in admins only: public,
    # it mapped every endpoint and parameter for anyone on the internet.
    openapi_url=None,
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.get(f"{settings.API_PREFIX}/openapi.json", include_in_schema=False)
def openapi_schema(_: object = Depends(require_min_role(OperatorRole.ADMIN.value))) -> JSONResponse:
    return JSONResponse(app.openapi())


@app.get(f"{settings.API_PREFIX}/docs", include_in_schema=False)
def swagger_ui(_: object = Depends(require_min_role(OperatorRole.ADMIN.value))) -> HTMLResponse:
    return get_swagger_ui_html(openapi_url=f"{settings.API_PREFIX}/openapi.json", title=f"{settings.PROJECT_NAME} API")

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        content_type = response.headers.get("content-type", "")
        if content_type == "application/json":
            response.headers["content-type"] = "application/json; charset=utf-8"
        return response


_cors_origins = ["*"] if settings.BACKEND_CORS_ALLOW_ALL else settings.BACKEND_CORS_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(ClientIPMiddleware)

app.include_router(api_router, prefix=settings.API_PREFIX)
app.include_router(websocket_router)
# Web Terminal relay WS (Platform Expansion Phase 5) — gated by FEATURE_TERMINAL
# inside the handlers (accept+close 4003 when off) plus the FEATURE_TERMINAL
# rollout scope enforced at session creation (app/platform_core/rollout.py).
# NPM already proxies this host's WS traffic.
from app.websocket.terminal_routes import router as terminal_ws_router  # noqa: E402
app.include_router(terminal_ws_router)

# Agent command channel: a persistent outbound WS per agent so interactive
# actions do not wait for the next heartbeat. Additive — actions are still
# queued first and the heartbeat path still delivers them to any agent that is
# not connected here. See app/websocket/agent_channel.py.
from app.websocket.agent_channel_routes import router as agent_channel_ws_router  # noqa: E402
app.include_router(agent_channel_ws_router)

app.include_router(legacy_compat_router)
app.include_router(rustdesk_audit_router)


@app.get("/health", summary="Health check")
def health() -> dict:
    return {"status": "ok", "environment": settings.ENVIRONMENT}


@app.post("/api/enroll")
def enroll_legacy(payload: AgentEnrollmentRequest, request: Request, db=Depends(get_db)):
    return agent_enroll(payload, request, db)
