"""Component Action API (Platform Components — Operational, Milestone 2).

    POST /devices/{device_id}/components/{component_id}/actions
    body: {"operation": "install|update|reinstall|repair|restart|discover|sync",
           "parameters": {...optional...}}

One registry-driven endpoint for every component lifecycle operation — no
per-operation route, no per-component branching. It resolves the operation to an
EXISTING ActionType (Milestone 1), enforces the same permission gate as the
generic device-action endpoint, and queues it through the unchanged action
pipeline (Milestone 4). Failures surface a stable ``code`` (from
``ComponentActionErrorCode``) mapped to a precise HTTP status.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import (
    get_current_operator,
    get_operator_permissions,
    get_operator_scope,
    require_min_role,
)
from app.core.scope import AllowedScope, device_in_scope
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.platform_core.action_resolver import (
    ComponentActionError,
    ComponentActionErrorCode,
)
from app.schemas.platform_component import (
    ComponentActionAccepted,
    ComponentActionHistoryItem,
    ComponentActionHistoryResponse,
    ComponentActionRequest,
)
from app.schemas.remote_action import RemoteActionResponse
from app.services.audit_service import AuditAction, audit_log
from app.services.component_action_service import ComponentActionService
from app.services.device_service import DeviceService
from app.services.permission_service import ACTION_PERMISSION_MAP

router = APIRouter()

# Stable code → HTTP status. Contract: the frontend keys off the JSON ``code``,
# not the status alone.
_ERROR_STATUS = {
    ComponentActionErrorCode.UNKNOWN_COMPONENT: 404,
    ComponentActionErrorCode.UNKNOWN_OPERATION: 400,
    ComponentActionErrorCode.UNSUPPORTED_OPERATION: 422,
    ComponentActionErrorCode.NOT_EXECUTABLE: 422,
    ComponentActionErrorCode.UNAVAILABLE_FOR_DEVICE: 422,
    ComponentActionErrorCode.NO_POLICY: 422,
    ComponentActionErrorCode.INVALID_VERSION: 400,
}


def _raise_component_error(exc: ComponentActionError) -> None:
    raise HTTPException(
        status_code=_ERROR_STATUS.get(exc.code, 400),
        detail={
            "code": exc.code.value,
            "detail": exc.message,
            "component_id": exc.component_id,
            "operation": exc.operation,
        },
    )


def _get_device_scoped(device_id: int, db: Session, scope: Optional[AllowedScope]):
    device = DeviceService(db).get_device(device_id)
    if not device or not device_in_scope(device.client_id, device.group_id, device.id, scope):
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.post(
    "/devices/{device_id}/components/{component_id}/actions",
    response_model=ComponentActionAccepted,
)
def queue_component_action(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
    component_id: str,
    payload: ComponentActionRequest,
):
    device = _get_device_scoped(device_id, db, scope)
    svc = ComponentActionService(db)

    # Resolve first (no side effects) so we can enforce the SAME permission gate
    # the generic device-action endpoint uses, keyed on the resolved ActionType.
    try:
        resolved = svc.resolve_for_device(
            device, component_id, payload.operation, parameters=payload.parameters
        )
    except ComponentActionError as exc:
        _raise_component_error(exc)

    required_perm = ACTION_PERMISSION_MAP.get(resolved.action_type.value)
    if required_perm:
        effective = get_operator_permissions(operator, db)
        if effective is not None and required_perm not in effective:
            raise HTTPException(status_code=403, detail=f"Permission denied: {required_perm}")

    try:
        result = svc.execute(
            device,
            component_id,
            payload.operation,
            created_by=operator.username,
            parameters=payload.parameters,
        )
    except ComponentActionError as exc:
        _raise_component_error(exc)
    except ValueError as exc:
        # Queue conflict / duplicate guard.
        raise HTTPException(status_code=409, detail=str(exc))

    action = result.action
    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_QUEUED,
        entity_type="remote_action",
        entity_id=action.id,
        details={
            "device_id": device_id,
            "component_id": result.resolved.component_id,
            "operation": result.resolved.operation.value,
            "action_type": action.action_type,
        },
    )
    return ComponentActionAccepted(
        component_id=result.resolved.component_id,
        operation=result.resolved.operation.value,
        action_type=result.resolved.action_type.value,
        label=result.resolved.label,
        action=RemoteActionResponse.model_validate(action),
    )


@router.get(
    "/devices/{device_id}/components/actions",
    response_model=ComponentActionHistoryResponse,
)
def component_action_history(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
    component_id: Optional[str] = Query(default=None),
    limit: int = Query(default=30, le=100),
):
    """History of component actions for a device (Milestone 7), newest first.

    Reuses the EXISTING remote_actions store — every queued RemoteAction that maps
    to a component (via the Lifecycle reverse index) is returned with its
    operation/user/timestamp/result/duration/component. Optional ``component_id``
    filter."""
    _get_device_scoped(device_id, db, scope)
    entries = ComponentActionService(db).history(
        device_id, component_id=component_id, limit=limit
    )
    items = []
    for entry in entries:
        base = RemoteActionResponse.model_validate(entry.action).model_dump()
        items.append(
            ComponentActionHistoryItem(
                **base,
                component_id=entry.component_id,
                operation=entry.operation,
                label=entry.label,
            )
        )
    return ComponentActionHistoryResponse(device_id=device_id, items=items)
