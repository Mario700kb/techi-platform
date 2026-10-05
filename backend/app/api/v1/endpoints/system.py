from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.schemas.system_status import SystemStatus
from app.services.system_status_service import system_status

router = APIRouter()


@router.get("/status", response_model=SystemStatus)
def read_system_status(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    """Real state of TECHI's own services. Owner and admin only."""
    return system_status(db)
