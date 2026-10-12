import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.agent_auth import _SlidingWindowRateLimiter
from app.core.auth import get_current_operator, require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.schemas.system_status import SystemStatus
from app.services.system_status_service import system_status

router = APIRouter()

client_error_logger = logging.getLogger("techi.client_errors")
# A render loop can throw on every frame; the log must not become the outage.
client_error_limiter = _SlidingWindowRateLimiter(limit=20, window_seconds=60)


class ClientErrorReport(BaseModel):
    message: str = Field(max_length=1000)
    name: Optional[str] = Field(default=None, max_length=200)
    stack: Optional[str] = Field(default=None, max_length=8000)
    component_stack: Optional[str] = Field(default=None, max_length=8000)
    url: Optional[str] = Field(default=None, max_length=1000)
    scope: Optional[str] = Field(default=None, max_length=50)
    release: Optional[str] = Field(default=None, max_length=100)
    user_agent: Optional[str] = Field(default=None, max_length=500)


@router.get("/status", response_model=SystemStatus)
def read_system_status(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    """Real state of TECHI's own services. Owner and admin only."""
    return system_status(db)


@router.post("/client-errors", status_code=status.HTTP_204_NO_CONTENT)
def report_client_error(
    report: ClientErrorReport,
    operator: Operator = Depends(get_current_operator),
):
    """Records a frontend crash caught by an error boundary or a global handler.

    Written to the backend log (redacted like every other line) so production
    UI failures are visible without a third-party error service.
    """
    if not client_error_limiter.is_allowed(f"operator:{operator.id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many error reports")
    client_error_logger.error(
        "client error: %s: %s | operator=%s scope=%s url=%s release=%s ua=%s\nstack: %s\ncomponent stack: %s",
        report.name or "Error",
        report.message,
        operator.id,
        report.scope or "-",
        report.url or "-",
        report.release or "-",
        report.user_agent or "-",
        report.stack or "-",
        report.component_stack or "-",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
