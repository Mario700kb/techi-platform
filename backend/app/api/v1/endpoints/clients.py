from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_team_permission
from app.core.scope import AllowedScope
from app.db.session import get_db
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.operator import Operator
from app.repositories.alert_repository import AlertRepository
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.device_repository import DeviceRepository
from app.schemas.alert import AlertCountResponse
from app.schemas.client import (
    Client,
    ClientActivityPage,
    ClientCreate,
    ClientProfile,
    ClientProfileGroup,
    ClientUpdate,
)
from app.services.client_service import ClientService
from app.services.device_overview_service import DeviceOverviewService
from app.services.operator_scope_service import OperatorScopeService
from app.services.permission_service import MANAGE_CLIENTS

router = APIRouter()

_require_manage_clients = require_team_permission(MANAGE_CLIENTS)


@router.get("", response_model=List[Client])
def list_clients(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    all_clients = ClientService(db).list_clients()
    if scope is None:
        return all_clients
    visible_ids = OperatorScopeService(db).get_visible_client_ids(scope)
    return [c for c in all_clients if c.id in visible_ids]


@router.post("", response_model=Client)
def create_client(
    payload: ClientCreate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    try:
        return ClientService(db).create_client(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{client_id}", response_model=Client)
def get_client(
    client_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    client = ClientService(db).get_client(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    if scope is not None:
        visible_ids = OperatorScopeService(db).get_visible_client_ids(scope)
        if client.id not in visible_ids:
            raise HTTPException(status_code=404, detail="Client not found")
    return client


def _client_in_scope(db: Session, scope: Optional[AllowedScope], client_id: int):
    client = ClientService(db).get_client(client_id)
    narrowed = OperatorScopeService(db).scope_for_client(scope, client_id) if client else None
    if narrowed is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return client, narrowed


@router.get("/{client_id}/profile", response_model=ClientProfile)
def get_client_profile(
    client_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Header and Overview of the client profile: devices by status and
    category, open alerts, health, updates and groups, within the operator's
    view of the client."""
    client, narrowed = _client_in_scope(db, scope, client_id)
    overview = DeviceOverviewService(db).get_overview(narrowed)
    alerts = AlertRepository(db).open_counts(narrowed)
    devices = DeviceRepository(db)._apply_scope_filter(
        db.query(Device).filter(Device.client_id == client_id, Device.is_archived.is_(False)), narrowed
    )
    group_rows = (
        devices.join(DeviceGroup, DeviceGroup.id == Device.group_id)
        .with_entities(DeviceGroup.id, DeviceGroup.name, func.count(Device.id))
        .group_by(DeviceGroup.id, DeviceGroup.name)
        .order_by(DeviceGroup.name)
        .all()
    )
    last_seen = devices.with_entities(func.max(Device.last_seen)).scalar()
    return ClientProfile(
        client=client,
        stats=overview.stats,
        by_category=overview.tree_counts.by_category,
        alerts=AlertCountResponse(
            total_open=alerts["total"],
            by_severity=alerts["by_severity"],
            by_kind=alerts["by_kind"],
            devices_affected=alerts["devices_affected"],
            oldest_open_at=alerts["oldest_open_at"],
        ),
        average_health=overview.average_health,
        health_critical=overview.critical,
        health_warning=overview.warnings,
        needs_updates=overview.needs_updates,
        agents_outdated=overview.agents_outdated,
        groups=[ClientProfileGroup(id=g_id, name=name, devices=count) for g_id, name, count in group_rows],
        last_seen=last_seen,
    )


@router.get("/{client_id}/activity", response_model=ClientActivityPage)
def get_client_activity(
    client_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Audit entries about the client or its devices (connections, actions,
    terminal sessions, credential use…), newest first."""
    _, narrowed = _client_in_scope(db, scope, client_id)
    device_ids = None
    if client_id not in narrowed.client_ids:
        device_ids = [
            row[0]
            for row in DeviceRepository(db)
            ._apply_scope_filter(db.query(Device.id).filter(Device.client_id == client_id), narrowed)
            .all()
        ]
    total, items = AuditLogRepository(db).for_client(client_id, device_ids, limit, offset)
    mentioned = {item.device_id for item in items if item.device_id is not None}
    names = (
        db.query(Device.id, Device.display_name, Device.hostname).filter(Device.id.in_(mentioned)).all()
        if mentioned
        else []
    )
    return ClientActivityPage(
        total=total,
        items=items,
        device_names={device_id: display or hostname for device_id, display, hostname in names},
    )


@router.put("/{client_id}", response_model=Client)
def update_client(
    client_id: int,
    payload: ClientUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    try:
        client = ClientService(db).update_client(client_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client


@router.delete("/{client_id}", response_model=Client)
def delete_client(
    client_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    client = ClientService(db).delete_client(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client
