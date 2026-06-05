from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_team_permission
from app.core.scope import AllowedScope
from app.db.session import get_db
from app.models.operator import Operator
from app.schemas.client import Client, ClientCreate, ClientUpdate
from app.services.client_service import ClientService
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
