from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.schemas.agent_command import (
    ADMIN_ONLY_COMMAND_TYPES,
    OWNER_ONLY_COMMAND_TYPES,
    BatchCreateResponse,
    BatchProgressResponse,
    BatchSummary,
    BulkCommandCreate,
)
from app.services.agent_command_service import AgentCommandService

router = APIRouter()


@router.post("/commands/bulk", response_model=BatchCreateResponse, status_code=201)
def bulk_command(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    payload: BulkCommandCreate,
):
    """Create a bulk command targeting multiple devices at once."""
    if payload.command_type in OWNER_ONLY_COMMAND_TYPES:
        if operator.role != "owner":
            raise HTTPException(
                status_code=403,
                detail=f"Command '{payload.command_type}' requires owner role",
            )
    elif payload.command_type in ADMIN_ONLY_COMMAND_TYPES:
        if operator.role not in {"admin", "owner"}:
            raise HTTPException(
                status_code=403,
                detail=f"Command '{payload.command_type}' requires admin or owner role",
            )

    try:
        result = AgentCommandService(db).create_bulk(
            create_in=payload,
            operator_id=operator.id,
            operator_username=operator.username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return result


@router.get("/commands/history", response_model=List[BatchSummary])
def command_history(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    limit: int = Query(default=20, le=100),
    skip: int = Query(default=0, ge=0),
):
    """List recent command batches."""
    return AgentCommandService(db).get_history(limit=limit, skip=skip)


@router.get("/commands/{batch_id}/progress", response_model=BatchProgressResponse)
def batch_progress(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    batch_id: str,
):
    """Get real-time progress for a command batch."""
    result = AgentCommandService(db).get_batch_progress(batch_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return result


@router.delete("/commands/{batch_id}", response_model=dict)
def cancel_batch(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    batch_id: str,
):
    """Cancel all queued (not yet delivered) commands in a batch."""
    try:
        return AgentCommandService(db).cancel_batch(batch_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
