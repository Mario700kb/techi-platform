from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.repositories.reenrollment_request_repository import ReenrollmentRequestRepository
from app.schemas.reenrollment import ReenrollmentRequestOut
from app.services.audit_service import AuditAction, audit_log
from app.services.reenrollment_service import ReenrollmentService

router = APIRouter()

_require_admin = require_min_role(OperatorRole.ADMIN.value)


def _to_out(request, devices_by_id) -> ReenrollmentRequestOut:
    out = ReenrollmentRequestOut.model_validate(request)
    device = devices_by_id.get(request.device_id)
    out.device_hostname = device.hostname if device else None
    return out


@router.get("", response_model=List[ReenrollmentRequestOut])
def list_reenrollment_requests(
    status: Optional[str] = Query(default="pending"),
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_admin),
):
    from app.repositories.device_repository import DeviceRepository

    rows = ReenrollmentRequestRepository(db).list(status=status or None)
    devices = DeviceRepository(db)
    devices_by_id = {r.device_id: devices.get(r.device_id) for r in rows}
    return [_to_out(r, devices_by_id) for r in rows]


@router.post("/{request_id}/approve", response_model=ReenrollmentRequestOut)
def approve_reenrollment(
    request_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    try:
        request = ReenrollmentService(db).approve(request_id, operator=operator.username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.REENROLLMENT_APPROVED, entity_type="device",
              entity_id=request.device_id, details={"request_id": request_id, "agent_id": request.agent_id})
    from app.repositories.device_repository import DeviceRepository

    return _to_out(request, {request.device_id: DeviceRepository(db).get(request.device_id)})


@router.post("/{request_id}/reject", response_model=ReenrollmentRequestOut)
def reject_reenrollment(
    request_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    try:
        request = ReenrollmentService(db).reject(request_id, operator=operator.username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.REENROLLMENT_REJECTED, entity_type="device",
              entity_id=request.device_id, details={"request_id": request_id, "agent_id": request.agent_id})
    from app.repositories.device_repository import DeviceRepository

    return _to_out(request, {request.device_id: DeviceRepository(db).get(request.device_id)})
