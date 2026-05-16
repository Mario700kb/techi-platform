import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_router
from app.core.config import settings
from app.db.session import engine
from app.services.schema_compat_service import ensure_sqlite_dev_schema
from app.services.auth_service import ensure_bootstrap_owner
from app.websocket.publisher import realtime_publisher
from app.websocket.routes import router as websocket_router
from app.workers.device_reconciliation_worker import device_reconciliation_worker

logger = logging.getLogger("techi.startup")

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.PROJECT_VERSION,
    openapi_url=f"{settings.API_PREFIX}/openapi.json",
    docs_url=f"{settings.API_PREFIX}/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.API_PREFIX)
app.include_router(websocket_router)


@app.on_event("startup")
async def start_background_workers() -> None:
    logger.info("Starting %s v%s [env=%s]", settings.PROJECT_NAME, settings.PROJECT_VERSION, settings.ENVIRONMENT)
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
    finally:
        db.close()
    realtime_publisher.start()
    device_reconciliation_worker.start()


@app.on_event("shutdown")
async def stop_background_workers() -> None:
    await device_reconciliation_worker.stop()
    await realtime_publisher.stop()


@app.get("/health", summary="Health check")
def health() -> dict:
    return {"status": "ok", "environment": settings.ENVIRONMENT}
