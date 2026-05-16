from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import require_roles
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.schemas.enrollment_bootstrap import (
    EnrollmentBootstrapMode,
    EnrollmentBootstrapRequest,
    EnrollmentBootstrapResponse,
)
from app.services.enrollment_bootstrap_service import EnrollmentBootstrapService

router = APIRouter()


@router.post("", response_model=EnrollmentBootstrapResponse)
def generate_enrollment_bootstrap(
    payload: EnrollmentBootstrapRequest,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    if payload.mode == EnrollmentBootstrapMode.TOKEN and not payload.enrollment_token_id:
        raise HTTPException(status_code=400, detail="enrollment_token_id is required for token enrollment mode")
    try:
        return EnrollmentBootstrapService(db).generate(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
