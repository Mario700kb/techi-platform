from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.agent_auth import verify_callback_token
from app.core.auth import get_current_operator, get_operator_permissions, get_operator_scope, require_min_role
from app.core.scope import AllowedScope, device_in_scope
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.schemas.remote_action import (
    ActionStatusStats,
    RemoteActionAck,
    RemoteActionComplete,
    RemoteActionCreate,
    RemoteActionFail,
    RemoteActionResponse,
    RemoteActionRunning,
    RemoteActionWithDevice,
)
from app.services.audit_service import AuditAction, audit_log
from app.services.device_service import DeviceService
from app.services.permission_service import ACTION_PERMISSION_MAP
from app.services.remote_action_service import RemoteActionService

router = APIRouter()


def _get_device_scoped(device_id: int, db: Session, scope: Optional[AllowedScope]):
    """Fetch a device and enforce scope, raising 404 on miss or out-of-scope."""
    device = DeviceService(db).get_device(device_id)
    if not device or not device_in_scope(device.client_id, device.group_id, device.id, scope):
        raise HTTPException(status_code=404, detail="Device not found")
    return device


def _check_action_scope(action_id: int, db: Session, scope: Optional[AllowedScope]):
    """Resolve an action → device and enforce scope, returning the action."""
    from app.repositories.remote_action_repository import RemoteActionRepository
    action = RemoteActionRepository(db).get(action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    if scope is not None:
        device = DeviceService(db).get_device(action.device_id)
        if not device or not device_in_scope(device.client_id, device.group_id, device.id, scope):
            raise HTTPException(status_code=404, detail="Action not found")
    return action


# ------------------------------------------------------------------ #
# Global                                                               #
# ------------------------------------------------------------------ #

@router.get("/actions/recent", response_model=List[RemoteActionWithDevice])
def list_recent_actions(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    limit: int = Query(default=20, le=100),
):
    """Return the most recent actions across all devices (scope-filtered)."""
    actions = RemoteActionService(db).get_recent_global(limit=limit * 3 if scope else limit)
    result = []
    for action in actions:
        if scope is not None:
            device = DeviceService(db).get_device(action.device_id)
            if not device or not device_in_scope(device.client_id, device.group_id, device.id, scope):
                continue
        resp = RemoteActionWithDevice.model_validate(action)
        if action.device:
            resp.device_hostname = action.device.hostname
        result.append(resp)
        if len(result) >= limit:
            break
    return result


# ------------------------------------------------------------------ #
# Device-scoped                                                        #
# ------------------------------------------------------------------ #

@router.get("/devices/{device_id}/actions/stats", response_model=ActionStatusStats)
def get_device_action_stats(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
):
    _get_device_scoped(device_id, db, scope)
    return RemoteActionService(db).get_stats(device_id)


@router.post("/devices/{device_id}/actions", response_model=RemoteActionResponse)
def queue_device_action(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
    payload: RemoteActionCreate,
):
    _get_device_scoped(device_id, db, scope)
    required_perm = ACTION_PERMISSION_MAP.get(payload.action_type.value)
    if required_perm:
        effective = get_operator_permissions(operator, db)
        if effective is not None and required_perm not in effective:
            raise HTTPException(status_code=403, detail=f"Permission denied: {required_perm}")
    try:
        if not payload.created_by:
            payload.created_by = operator.username
        action = RemoteActionService(db).queue_action(device_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.ACTION_QUEUED, entity_type="remote_action", entity_id=action.id, details={"device_id": device_id, "action_type": action.action_type})
    return RemoteActionResponse.model_validate(action)


@router.get("/devices/{device_id}/actions", response_model=List[RemoteActionResponse])
def list_device_actions(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
    limit: int = Query(default=30, le=100),
    status: Optional[str] = Query(default=None),
):
    _get_device_scoped(device_id, db, scope)
    svc = RemoteActionService(db)
    if status:
        actions = svc.get_filtered(device_id, status=status, limit=limit)
    else:
        actions = svc.get_recent(device_id, limit=limit)
    return [RemoteActionResponse.model_validate(a) for a in actions]


# ------------------------------------------------------------------ #
# Action-level transitions (agent calls — no scope needed)            #
# ------------------------------------------------------------------ #

@router.post("/actions/{action_id}/ack", response_model=RemoteActionResponse)
def ack_action(
    *,
    db: Session = Depends(get_db),
    action_id: int,
    payload: RemoteActionAck = RemoteActionAck(),
    x_callback_secret: Optional[str] = Header(default=None),
):
    if not verify_callback_token(action_id, x_callback_secret or ""):
        raise HTTPException(status_code=401, detail="Invalid or missing callback secret")
    try:
        action = RemoteActionService(db).acknowledge(action_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    return RemoteActionResponse.model_validate(action)


@router.post("/actions/{action_id}/running", response_model=RemoteActionResponse)
def running_action(
    *,
    db: Session = Depends(get_db),
    action_id: int,
    payload: RemoteActionRunning = RemoteActionRunning(),
    x_callback_secret: Optional[str] = Header(default=None),
):
    if not verify_callback_token(action_id, x_callback_secret or ""):
        raise HTTPException(status_code=401, detail="Invalid or missing callback secret")
    try:
        action = RemoteActionService(db).mark_running(action_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    return RemoteActionResponse.model_validate(action)


@router.post("/actions/{action_id}/complete", response_model=RemoteActionResponse)
def complete_action(
    *,
    db: Session = Depends(get_db),
    action_id: int,
    payload: RemoteActionComplete,
    x_callback_secret: Optional[str] = Header(default=None),
):
    if not verify_callback_token(action_id, x_callback_secret or ""):
        raise HTTPException(status_code=401, detail="Invalid or missing callback secret")
    try:
        action = RemoteActionService(db).complete(
            action_id, result_message=payload.result_message, output=payload.output
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    return RemoteActionResponse.model_validate(action)


@router.post("/actions/{action_id}/fail", response_model=RemoteActionResponse)
def fail_action(
    *,
    db: Session = Depends(get_db),
    action_id: int,
    payload: RemoteActionFail,
    x_callback_secret: Optional[str] = Header(default=None),
):
    if not verify_callback_token(action_id, x_callback_secret or ""):
        raise HTTPException(status_code=401, detail="Invalid or missing callback secret")
    try:
        action = RemoteActionService(db).fail(
            action_id, error_message=payload.error_message, stderr_output=payload.stderr_output
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    return RemoteActionResponse.model_validate(action)


@router.post("/actions/{action_id}/cancel", response_model=RemoteActionResponse)
def cancel_action(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    action_id: int,
):
    _check_action_scope(action_id, db, scope)
    try:
        action = RemoteActionService(db).cancel_action(action_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    audit_log(db, operator=operator, action=AuditAction.ACTION_CANCELLED, entity_type="remote_action", entity_id=action_id, details={"device_id": action.device_id, "action_type": action.action_type})
    return RemoteActionResponse.model_validate(action)


@router.post("/actions/{action_id}/retry", response_model=RemoteActionResponse)
def retry_action(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    action_id: int,
):
    _check_action_scope(action_id, db, scope)
    try:
        action = RemoteActionService(db).retry_action(action_id, caller_username=operator.username)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.ACTION_RETRIED, entity_type="remote_action", entity_id=action.id, details={"device_id": action.device_id, "action_type": action.action_type})
    return RemoteActionResponse.model_validate(action)
