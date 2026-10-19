import logging

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from app.core.config import settings
from app.db.session import engine
from app.schemas.health import HealthResponse

router = APIRouter()
logger = logging.getLogger("techi.health")


@router.get("/health", response_model=HealthResponse, summary="API health check")
async def read_health() -> HealthResponse:
    """Liveness: the process answers. Deliberately no database check — a
    container restart cannot fix a database outage, and restarting would
    only add a reconnect storm to it."""
    return HealthResponse(status="ok", environment=settings.ENVIRONMENT)


@router.get("/health/ready", summary="Readiness: the API can reach its database")
def read_readiness(response: Response) -> dict:
    """Readiness for monitoring and the post-deploy smoke test: 503 when the
    database does not answer a trivial query within two seconds."""
    try:
        with engine.connect() as connection:
            if connection.dialect.name == "postgresql":
                connection.execute(text("SET LOCAL statement_timeout = 2000"))
            connection.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Readiness check: database unreachable")
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "database": "unreachable"}
    return {"status": "ok", "database": "ok"}
