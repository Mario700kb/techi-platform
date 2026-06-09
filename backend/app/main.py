import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import logging
import os

from app.core.logging_config import configure_logging

configure_logging()

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.legacy_compat import router as legacy_compat_router
from app.api.v1.api import api_router
from app.api.v1.endpoints.agent import agent_enroll
from app.core.config import settings
from app.db.session import engine, get_db
from app.schemas.agent import AgentEnrollmentRequest
from app.services.schema_compat_service import ensure_sqlite_dev_schema
from app.services.auth_service import ensure_bootstrap_owner
from app.services.enrollment_token_service import EnrollmentTokenService
from app.websocket.publisher import realtime_publisher
from app.websocket.routes import router as websocket_router
from app.workers.device_reconciliation_worker import device_reconciliation_worker

logger = logging.getLogger("techi.startup")


def _run_heartbeat_cleanup() -> None:
    from app.db.session import SessionLocal
    from app.tasks.cleanup import cleanup_old_heartbeats
    db = SessionLocal()
    try:
        cleanup_old_heartbeats(db)
    except Exception:
        logger.exception("Heartbeat cleanup failed")
    finally:
        db.close()


async def _heartbeat_cleanup_scheduler() -> None:
    await asyncio.to_thread(_run_heartbeat_cleanup)
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

    yield

    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
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

_cors_origins = ["*"] if settings.BACKEND_CORS_ALLOW_ALL else settings.BACKEND_CORS_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.API_PREFIX)
app.include_router(websocket_router)
app.include_router(legacy_compat_router)


@app.get("/health", summary="Health check")
def health() -> dict:
    return {"status": "ok", "environment": settings.ENVIRONMENT}


@app.post("/api/enroll")
def enroll_legacy(payload: AgentEnrollmentRequest, request: Request, db=Depends(get_db)):
    return agent_enroll(payload, request, db)
