from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.schemas.agent_package import AgentPackageOut
from app.services.agent_package_service import AgentPackageService

router = APIRouter()


@router.get("/latest", response_model=Optional[AgentPackageOut])
def get_latest_package(platform: str = Query(..., description="Platform identifier, e.g. windows")):
    package = AgentPackageService().latest_active(platform)
    if package is None:
        raise HTTPException(status_code=404, detail=f"No active package for platform '{platform}'")
    return package
