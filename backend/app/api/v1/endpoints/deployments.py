from datetime import datetime, timedelta
from app.core.time import utcnow
from typing import List

from fastapi import APIRouter, Depends

from app.core.auth import require_team_permission
from app.schemas.deployment import RecentDeployment
from app.services.permission_service import DEPLOYMENT

router = APIRouter()


@router.get("/recent", response_model=List[RecentDeployment])
def read_recent_deployments(_: None = Depends(require_team_permission(DEPLOYMENT))):
    now = utcnow()
    return [
        RecentDeployment(
            id=1,
            title="TECHI Remote Support agent update",
            environment="Production",
            status="success",
            timestamp=now - timedelta(hours=1, minutes=24),
        ),
        RecentDeployment(
            id=2,
            title="Client onboarding batch",
            environment="Staging",
            status="warning",
            timestamp=now - timedelta(hours=3, minutes=12),
        ),
        RecentDeployment(
            id=3,
            title="Server configuration push",
            environment="Production",
            status="success",
            timestamp=now - timedelta(days=1, hours=2),
        ),
        RecentDeployment(
            id=4,
            title="Policy sync failed",
            environment="QA",
            status="failed",
            timestamp=now - timedelta(days=1, hours=6),
        ),
    ]
