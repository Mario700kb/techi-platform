import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import logging
import os

from app.core.logging_config import configure_logging

configure_logging()

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from app.api.legacy_compat import router as legacy_compat_router
from app.api.v1.api import api_router
from app.api.v1.endpoints.agent import agent_enroll
from app.core.config import settings
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

logger = logging.getLogger("techi.startup")


def _run_heartbeat_cleanup() -> None:
    from app.db.session import SessionLocal
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
        cleanup_old_remote_support_connect_tokens,
    )
    tasks = (
        cleanup_old_heartbeats,
        cleanup_old_telemetry,
        cleanup_old_activity_events,
        cleanup_resolved_alerts,
        cleanup_old_remote_actions,
        cleanup_old_command_batches,
        cleanup_old_status_history,
        cleanup_old_audit_logs,
        cleanup_old_enrollment_audit,
        cleanup_old_remote_support_connect_tokens,
    )
    db = SessionLocal()
    try:
        # Each task commits/vacuums independently; one failure must not stop the rest.
        for task in tasks:
            try:
                task(db)
            except Exception:
                db.rollback()
                logger.exception("Cleanup task %s failed", task.__name__)
    finally:
        db.close()


async def _heartbeat_cleanup_scheduler() -> None:
    while True:
        now = datetime.utcnow()
        next_03 = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if next_03 <= now:
            next_03 += timedelta(days=1)
        delay = (next_03 - now).total_seconds()
        logger.info("Next heartbeat cleanup at %s UTC (in %.0fs)", next_03.isoformat(), delay)
        await asyncio.sleep(delay)
        await asyncio.to_thread(_run_heartbeat_cleanup)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s v%s [env=%s]", settings.PROJECT_NAME, settings.PROJECT_VERSION, settings.ENVIRONMENT)
    if settings.BACKEND_CORS_ALLOW_ALL:
        logger.warning("CORS: allow_all=true — all origins permitted (LAN/dev mode only)")
    else:
        logger.info("CORS origins: %s", settings.BACKEND_CORS_ORIGINS)
    logger.info("Database: %s", settings.DATABASE_URL)

    if settings.ENVIRONMENT != "development" and not settings.BOOTSTRAP_OWNER_PASSWORD:
        logger.warning("BOOTSTRAP_OWNER_PASSWORD is not set — bootstrap owner will use a random password")

    pkg_dir = settings.AGENT_PACKAGE_STORAGE_DIR
    if pkg_dir and not os.path.isdir(pkg_dir):
        logger.warning("AGENT_PACKAGE_STORAGE_DIR does not exist or is not accessible: %s", pkg_dir)

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
    # Only runs when the feature is actually reachable — flag OFF stays
    # zero-extra-behavior (no new periodic queries).
    if feature_enabled("FEATURE_TERMINAL"):
        terminal_watchdog.start()
        ssh_connector_runner.start()
    if feature_enabled("FEATURE_NOTIFICATIONS"):
        notification_worker.start()
    if feature_enabled("FEATURE_REPORTING"):
        report_worker.start()

    yield

    cleanup_task.cancel()
    try:
        await cleanup_task
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
    openapi_url=f"{settings.API_PREFIX}/openapi.json",
    docs_url=f"{settings.API_PREFIX}/docs",
    redoc_url=None,
    lifespan=lifespan,
)

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

app.include_router(api_router, prefix=settings.API_PREFIX)
app.include_router(websocket_router)
# Web Terminal relay WS (Platform Expansion Phase 5) — gated by FEATURE_TERMINAL
# inside the handlers (accept+close 4003 when off) plus the FEATURE_TERMINAL
# rollout scope enforced at session creation (app/platform_core/rollout.py).
# NPM already proxies this host's WS traffic.
from app.websocket.terminal_routes import router as terminal_ws_router  # noqa: E402
app.include_router(terminal_ws_router)
app.include_router(legacy_compat_router)


@app.get("/health", summary="Health check")
def health() -> dict:
    return {"status": "ok", "environment": settings.ENVIRONMENT}


@app.post("/api/enroll")
def enroll_legacy(payload: AgentEnrollmentRequest, request: Request, db=Depends(get_db)):
    return agent_enroll(payload, request, db)
