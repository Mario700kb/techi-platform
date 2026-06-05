from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_team_permission
from app.core.scope import AllowedScope
from app.db.session import get_db
from app.models.operator import Operator
from app.services.permission_service import MANAGE_GROUPS
from app.schemas.device_group import (
    DeviceGroup,
    DeviceGroupCreate,
    DeviceGroupDuplicateCleanupRequest,
    DeviceGroupDuplicateCleanupResult,
    DeviceGroupUpdate,
)
from app.services.device_group_service import DeviceGroupService
from app.services.operator_scope_service import OperatorScopeService

router = APIRouter()

_require_manage_groups = require_team_permission(MANAGE_GROUPS)


@router.get("", response_model=List[DeviceGroup])
def list_groups(
    client_id: Optional[int] = None,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    all_groups = DeviceGroupService(db).list_groups(client_id=client_id)
    if scope is None:
        return all_groups
    visible_ids = OperatorScopeService(db).get_visible_group_ids(scope)
    return [g for g in all_groups if g.id in visible_ids]


@router.post("", response_model=DeviceGroup)
def create_group(
    payload: DeviceGroupCreate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_groups),
):
    try:
        return DeviceGroupService(db).create_group(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/cleanup-duplicates", response_model=DeviceGroupDuplicateCleanupResult)
def cleanup_duplicate_groups(
    payload: DeviceGroupDuplicateCleanupRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_groups),
):
    try:
        return DeviceGroupService(db).cleanup_duplicate_groups(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{group_id}", response_model=DeviceGroup)
def update_group(
    group_id: int,
    payload: DeviceGroupUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_groups),
):
    try:
        group = DeviceGroupService(db).update_group(group_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


@router.delete("/{group_id}", response_model=DeviceGroup)
def delete_group(
    group_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_groups),
):
    group = DeviceGroupService(db).delete_group(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group
