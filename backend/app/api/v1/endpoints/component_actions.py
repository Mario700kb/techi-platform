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
    is_unrestricted,
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
    BulkComponentActionItem,
    BulkComponentActionRequest,
    BulkComponentActionResponse,
    ComponentActionAccepted,
    ComponentActionHistoryItem,
    ComponentActionHistoryResponse,
    ComponentActionRequest,
    ComponentPackageStatusOut,
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
    ComponentActionErrorCode.INVALID_TIMEOUT: 400,
    ComponentActionErrorCode.NOT_A_COMPONENT_ACTION: 422,
    ComponentActionErrorCode.POLICY_DENIED: 403,
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
    # A policy override is honored only for an elevated operator (owner/admin).
    override = bool(payload.override) and is_unrestricted(operator)

    # Resolve first (no side effects) so we can enforce the SAME permission gate
    # the generic device-action endpoint uses, keyed on the resolved ActionType.
    try:
        resolved = svc.resolve_for_device(
            device, component_id, payload.operation,
            parameters=payload.parameters, timeout_seconds=payload.timeout_seconds,
            override=override,
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
            timeout_seconds=payload.timeout_seconds,
            override=override,
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


_BULK_MAX_ITEMS = 1000  # device_ids × targets ceiling — guards against abuse.


@router.post(
    "/components/actions/bulk",
    response_model=BulkComponentActionResponse,
)
def bulk_component_actions(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    payload: BulkComponentActionRequest,
):
    """Apply operations across multiple devices × multiple components (Milestone 9).

    Each (device, component, operation) is queued independently through the
    existing pipeline; per-item validation + partial-failure reporting means one
    bad item never fails the batch. Progress is observable live via the existing
    realtime action events (M6). Devices out of scope / missing are reported as
    ``device_not_found`` items, never leaked."""
    device_ids = list(dict.fromkeys(payload.device_ids))  # dedupe, preserve order
    targets = [(t.component_id, t.operation) for t in payload.targets]
    if not device_ids or not targets:
        raise HTTPException(status_code=400, detail="device_ids and targets are required")
    if len(device_ids) * len(targets) > _BULK_MAX_ITEMS:
        raise HTTPException(
            status_code=400,
            detail=f"Bulk request too large (> {_BULK_MAX_ITEMS} device×target items)",
        )

    # Scope-check every device up front; only in-scope devices enter the map.
    device_by_id = {}
    device_service = DeviceService(db)
    for device_id in device_ids:
        device = device_service.get_device(device_id)
        if device and device_in_scope(device.client_id, device.group_id, device.id, scope):
            device_by_id[device_id] = device

    effective = get_operator_permissions(operator, db)
    override = bool(payload.override) and is_unrestricted(operator)
    results = ComponentActionService(db).bulk_execute(
        device_ids=device_ids,
        device_by_id=device_by_id,
        targets=targets,
        created_by=operator.username,
        effective_permissions=effective,
        parameters=payload.parameters,
        timeout_seconds=payload.timeout_seconds,
        override=override,
    )

    items = [
        BulkComponentActionItem(
            device_id=r.device_id,
            component_id=r.component_id,
            operation=r.operation,
            ok=r.ok,
            action_id=r.action.id if r.action else None,
            action_type=r.action.action_type if r.action else None,
            status=r.action.status.value if r.action else None,
            error_code=r.error_code,
            error=r.error,
        )
        for r in results
    ]
    succeeded = sum(1 for r in results if r.ok)
    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_QUEUED,
        entity_type="remote_action",
        entity_id=0,
        details={
            "bulk": True,
            "devices": len(device_ids),
            "targets": len(targets),
            "succeeded": succeeded,
            "failed": len(items) - succeeded,
        },
    )
    return BulkComponentActionResponse(
        total=len(items),
        succeeded=succeeded,
        failed=len(items) - succeeded,
        items=items,
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


@router.get(
    "/devices/{device_id}/components/{component_id}/package",
    response_model=ComponentPackageStatusOut,
)
def component_package_status(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
    component_id: str,
):
    """Package status for a component on a device (Milestone 11): Installed /
    Desired / Available versions + Outdated detection. Read-only; reuses the STABLE
    Desired-State resolver and the Package Registry (no new storage)."""
    device = _get_device_scoped(device_id, db, scope)
    from app.services.component_package_service import ComponentPackageService

    status = ComponentPackageService(db).status_for(device, component_id)
    return ComponentPackageStatusOut(
        device_id=device_id,
        component_id=status.component_id,
        installed_version=status.installed_version,
        desired_version=status.desired_version,
        available_version=status.available_version,
        outdated=status.outdated,
    )


@router.post(
    "/devices/{device_id}/components/actions/{action_id}/retry",
    response_model=ComponentActionAccepted,
)
def retry_component_action(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
    action_id: int,
):
    """Retry a terminal component action (Milestone 8). Re-validates that the
    operation is still allowed for the device, enforces the same permission gate,
    and re-queues through the existing retry path (idempotency guard applies)."""
    device = _get_device_scoped(device_id, db, scope)
    from app.repositories.remote_action_repository import RemoteActionRepository

    action = RemoteActionRepository(db).get(action_id)
    if not action or action.device_id != device_id:
        raise HTTPException(status_code=404, detail="Action not found")

    required_perm = ACTION_PERMISSION_MAP.get(action.action_type)
    if required_perm:
        effective = get_operator_permissions(operator, db)
        if effective is not None and required_perm not in effective:
            raise HTTPException(status_code=403, detail=f"Permission denied: {required_perm}")

    svc = ComponentActionService(db)
    try:
        result = svc.retry(device, action, created_by=operator.username)
    except ComponentActionError as exc:
        _raise_component_error(exc)
    except ValueError as exc:
        # Non-terminal status (retry not allowed) or duplicate/conflict.
        raise HTTPException(status_code=409, detail=str(exc))

    new_action = result.action
    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_RETRIED,
        entity_type="remote_action",
        entity_id=new_action.id,
        details={
            "device_id": device_id,
            "component_id": result.resolved.component_id,
            "operation": result.resolved.operation.value,
            "action_type": new_action.action_type,
            "retried_from": action_id,
        },
    )
    return ComponentActionAccepted(
        component_id=result.resolved.component_id,
        operation=result.resolved.operation.value,
        action_type=result.resolved.action_type.value,
        label=result.resolved.label,
        action=RemoteActionResponse.model_validate(new_action),
    )
