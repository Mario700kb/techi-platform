from fastapi import APIRouter

from app.schemas.health import HealthResponse
from app.core.config import settings

router = APIRouter()


@router.get("/health", response_model=HealthResponse, summary="API health check")
def read_health() -> HealthResponse:
    return HealthResponse(status="ok", environment=settings.ENVIRONMENT)
