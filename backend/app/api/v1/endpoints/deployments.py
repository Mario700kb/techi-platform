from typing import List

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import require_team_permission
from app.db.session import get_db
from app.schemas.deployment import RecentDeployment
from app.services.deployment_service import recent_deployments
from app.services.permission_service import DEPLOYMENT

router = APIRouter()


@router.get("/recent", response_model=List[RecentDeployment])
def read_recent_deployments(
    *,
    db: Session = Depends(get_db),
    _: None = Depends(require_team_permission(DEPLOYMENT)),
    limit: int = Query(default=5, ge=1, le=20),
):
    """The most recent fleet command batches, with their real outcome."""
    return recent_deployments(db, limit=limit)
