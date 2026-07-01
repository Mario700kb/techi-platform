from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import require_team_permission
from app.db.session import get_db
from app.schemas.trusted_domain import TrustedDomain, TrustedDomainCreate, TrustedDomainUpdate
from app.services.permission_service import MANAGE_CLIENTS
from app.services.trusted_domain_admin_service import TrustedDomainAdminService

router = APIRouter()

_require_manage_clients = require_team_permission(MANAGE_CLIENTS)


@router.get("", response_model=List[TrustedDomain])
def list_trusted_domains(
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    return TrustedDomainAdminService(db).list_domains()


@router.post("", response_model=TrustedDomain)
def create_trusted_domain(
    payload: TrustedDomainCreate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    try:
        return TrustedDomainAdminService(db).create_domain(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{domain_id}", response_model=TrustedDomain)
def update_trusted_domain(
    domain_id: int,
    payload: TrustedDomainUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    try:
        domain = TrustedDomainAdminService(db).update_domain(domain_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not domain:
        raise HTTPException(status_code=404, detail="Trusted domain not found")
    return domain


@router.delete("/{domain_id}", response_model=TrustedDomain)
def delete_trusted_domain(
    domain_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    domain = TrustedDomainAdminService(db).delete_domain(domain_id)
    if not domain:
        raise HTTPException(status_code=404, detail="Trusted domain not found")
    return domain
