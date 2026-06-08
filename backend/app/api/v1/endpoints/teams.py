from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.repositories.team_repository import _decode_permissions
from app.schemas.team import (
    AccessUpdateRequest,
    MemberUpdateRequest,
    TeamCreate,
    TeamDetailResponse,
    TeamPermissionsUpdateRequest,
    TeamUpdate,
    TeamWithStats,
)
from app.services.audit_service import AuditAction, audit_log
from app.services.team_service import TeamService

router = APIRouter(dependencies=[Depends(get_current_operator)])


def _require_admin(operator: Operator = Depends(get_current_operator)) -> Operator:
    from app.core.auth import ROLE_ORDER
    if ROLE_ORDER.get(operator.role, -1) < ROLE_ORDER.get(OperatorRole.ADMIN.value, 2):
        raise HTTPException(status_code=403, detail="Admin or owner required")
    return operator


# ── List / Get ─────────────────────────────────────────────────────────── #

@router.get("/", response_model=List[TeamWithStats])
def list_teams(
    db: Session = Depends(get_db),
    _operator: Operator = Depends(get_current_operator),
):
    return [TeamWithStats(**item) for item in TeamService(db).list_teams_with_stats()]


@router.get("/{team_id}", response_model=TeamDetailResponse)
def get_team(
    team_id: int,
    db: Session = Depends(get_db),
    _operator: Operator = Depends(get_current_operator),
):
    detail = TeamService(db).get_team_detail(team_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Team not found")
    return TeamDetailResponse(**detail)


# ── Create / Update / Delete ───────────────────────────────────────────── #

@router.post("/", response_model=TeamDetailResponse)
def create_team(
    payload: TeamCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = TeamService(db)
    if service.get_team_detail(0) is not None:
        pass  # name uniqueness handled by DB constraint
    try:
        team = service.create_team(name=payload.name, description=payload.description, color=payload.color, permissions=payload.permissions)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.TEAM_CREATED, entity_type="team", entity_id=team.id, details={"name": team.name})
    detail = service.get_team_detail(team.id)
    return TeamDetailResponse(**detail)


@router.put("/{team_id}", response_model=TeamDetailResponse)
def update_team(
    team_id: int,
    payload: TeamUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = TeamService(db)
    updated = service.update_team(team_id, **payload.model_dump(exclude_unset=True))
    if not updated:
        raise HTTPException(status_code=404, detail="Team not found")
    audit_log(db, operator=operator, action=AuditAction.TEAM_UPDATED, entity_type="team", entity_id=team_id)
    detail = service.get_team_detail(team_id)
    return TeamDetailResponse(**detail)


@router.delete("/{team_id}")
def delete_team(
    team_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    if not TeamService(db).delete_team(team_id):
        raise HTTPException(status_code=404, detail="Team not found")
    audit_log(db, operator=operator, action=AuditAction.TEAM_DELETED, entity_type="team", entity_id=team_id)
    return {"message": "Team deleted"}


# ── Members ────────────────────────────────────────────────────────────── #

@router.put("/{team_id}/members")
def replace_members(
    team_id: int,
    payload: MemberUpdateRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = TeamService(db)
    if not service.get_team(team_id):
        raise HTTPException(status_code=404, detail="Team not found")
    service.replace_members(team_id, payload.operator_ids)
    audit_log(db, operator=operator, action=AuditAction.TEAM_MEMBER_ADDED, entity_type="team", entity_id=team_id, details={"operator_ids": payload.operator_ids})
    return {"message": "Members updated", "operator_ids": payload.operator_ids}


@router.delete("/{team_id}/members/{operator_id}")
def remove_member(
    team_id: int,
    operator_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    if not TeamService(db).remove_member(team_id, operator_id):
        raise HTTPException(status_code=404, detail="Member not found in team")
    audit_log(db, operator=operator, action=AuditAction.TEAM_MEMBER_REMOVED, entity_type="team", entity_id=team_id, details={"operator_id": operator_id})
    return {"message": "Member removed"}


# ── Access management ──────────────────────────────────────────────────── #

@router.put("/{team_id}/client-access")
def set_client_access(
    team_id: int,
    payload: AccessUpdateRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = TeamService(db)
    if not service.get_team(team_id):
        raise HTTPException(status_code=404, detail="Team not found")
    service.replace_client_access(team_id, payload.ids)
    audit_log(db, operator=operator, action=AuditAction.TEAM_ACCESS_UPDATED, entity_type="team", entity_id=team_id, details={"type": "clients", "ids": payload.ids})
    return {"message": "Client access updated", "client_ids": payload.ids}


@router.put("/{team_id}/group-access")
def set_group_access(
    team_id: int,
    payload: AccessUpdateRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = TeamService(db)
    if not service.get_team(team_id):
        raise HTTPException(status_code=404, detail="Team not found")
    service.replace_group_access(team_id, payload.ids)
    audit_log(db, operator=operator, action=AuditAction.TEAM_ACCESS_UPDATED, entity_type="team", entity_id=team_id, details={"type": "groups", "ids": payload.ids})
    return {"message": "Group access updated", "group_ids": payload.ids}


@router.put("/{team_id}/device-access")
def set_device_access(
    team_id: int,
    payload: AccessUpdateRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = TeamService(db)
    if not service.get_team(team_id):
        raise HTTPException(status_code=404, detail="Team not found")
    service.replace_device_access(team_id, payload.ids)
    audit_log(db, operator=operator, action=AuditAction.TEAM_ACCESS_UPDATED, entity_type="team", entity_id=team_id, details={"type": "devices", "ids": payload.ids})
    return {"message": "Device access updated", "device_ids": payload.ids}


@router.put("/{team_id}/permissions", response_model=TeamDetailResponse)
def set_permissions(
    team_id: int,
    payload: TeamPermissionsUpdateRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = TeamService(db)
    updated = service.update_team(team_id, permissions=payload.permissions)
    if not updated:
        raise HTTPException(status_code=404, detail="Team not found")
    audit_log(db, operator=operator, action=AuditAction.TEAM_UPDATED, entity_type="team", entity_id=team_id, details={"permissions": payload.permissions})
    detail = service.get_team_detail(team_id)
    return TeamDetailResponse(**detail)
