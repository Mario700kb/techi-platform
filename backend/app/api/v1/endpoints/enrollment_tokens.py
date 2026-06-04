from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_roles
from app.core.config import settings
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.schemas.enrollment_bootstrap import (
    AvailabilityProfile,
    EnrollmentBootstrapPlatform,
    EnrollmentBootstrapRequest,
)
from app.schemas.enrollment_token import (
    EnrollmentTokenCreate,
    EnrollmentTokenCreateResponse,
    EnrollmentTokenDeployment,
    EnrollmentTokenOut,
    EnrollmentTokenUpdate,
    EnrollmentTokenVerifyRequest,
    EnrollmentTokenVerifyResponse,
)
from app.services.enrollment_bootstrap_service import EnrollmentBootstrapService
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.audit_service import AuditAction, audit_log

router = APIRouter()


def _public_backend_url(request: Request) -> str:
    configured = (settings.PUBLIC_BACKEND_URL or "").strip()
    if configured:
        return EnrollmentBootstrapService.normalize_backend_url(configured)
    return EnrollmentBootstrapService.normalize_backend_url(str(request.base_url))


@router.post("", response_model=EnrollmentTokenCreateResponse)
def create_enrollment_token(
    payload: EnrollmentTokenCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    result = EnrollmentTokenService(db).create(payload)
    audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_UPDATED, entity_type="enrollment_token", entity_id=result.id, details={"name": result.name, "created": True})
    return result


@router.get("", response_model=List[EnrollmentTokenOut])
def list_enrollment_tokens(
    db: Session = Depends(get_db),
    _: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
    limit: int = Query(default=100, le=200),
    offset: int = Query(default=0, ge=0),
):
    return EnrollmentTokenService(db).list(limit=limit, offset=offset)


@router.post("/default/regenerate", response_model=EnrollmentTokenCreateResponse)
def regenerate_default_enrollment_token(
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    result = EnrollmentTokenService(db).regenerate_default()
    audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_REGENERATED, entity_type="enrollment_token", entity_id=result.id, details={"name": result.name})
    return result


@router.get("/{token_id}", response_model=EnrollmentTokenOut)
def get_enrollment_token(
    token_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        token = EnrollmentTokenService(db).get(token_id)
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_VIEWED, entity_type="enrollment_token", entity_id=token.id, details={"name": token.name})
        return token
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.patch("/{token_id}", response_model=EnrollmentTokenOut)
def update_enrollment_token(
    token_id: int,
    payload: EnrollmentTokenUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        token = EnrollmentTokenService(db).update(token_id, payload)
        audit_log(
            db,
            operator=operator,
            action=AuditAction.ENROLLMENT_TOKEN_UPDATED,
            entity_type="enrollment_token",
            entity_id=token.id,
            details={"name": token.name, "fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        )
        return token
    except ValueError as exc:
        detail = str(exc)
        if "not found" in detail.lower():
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)


@router.post("/{token_id}/regenerate", response_model=EnrollmentTokenCreateResponse)
def regenerate_enrollment_token(
    token_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        result = EnrollmentTokenService(db).regenerate(token_id)
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_REGENERATED, entity_type="enrollment_token", entity_id=result.id, details={"name": result.name})
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{token_id}/deployment", response_model=EnrollmentTokenDeployment)
def get_enrollment_token_deployment(
    token_id: int,
    request: Request,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        deployment = EnrollmentTokenService(db).deployment(token_id, backend_url=_public_backend_url(request))
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_DEPLOYMENT_VIEWED, entity_type="enrollment_token", entity_id=token_id, details={"token_available": deployment.token_available})
        return deployment
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{token_id}/bootstrap.ps1")
def get_enrollment_token_bootstrap_script(
    token_id: int,
    request: Request,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    service = EnrollmentTokenService(db)
    try:
        token = service.get(token_id)
        plaintext_token = service.decrypt_token(token.token_ciphertext)
        if not plaintext_token:
            raise HTTPException(status_code=409, detail="Token value is not recoverable. Regenerate token value first.")
        payload = EnrollmentBootstrapRequest(
            mode="token",
            enrollment_token_id=token.id,
            backend_url=_public_backend_url(request),
            platform=EnrollmentBootstrapPlatform.WINDOWS,
            enrollment_token=plaintext_token,
            availability_profile=AvailabilityProfile.SERVER,
            manage_power_policy=True,
        )
        bootstrap = EnrollmentBootstrapService(db).generate(payload)
        filename = getattr(bootstrap, "installer_filename", None) or "techi-bootstrap.ps1"
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_BOOTSTRAP_DOWNLOADED, entity_type="enrollment_token", entity_id=token.id, details={"name": token.name})
        return Response(
            content=bootstrap.bootstrap_script,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

@router.put("/{token_id}/revoke", response_model=EnrollmentTokenOut)
def revoke_enrollment_token(
    token_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        token = EnrollmentTokenService(db).revoke(token_id)
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_REVOKED, entity_type="enrollment_token", entity_id=token.id, details={"name": token.name})
        return token
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete("/{token_id}", response_model=EnrollmentTokenOut)
def delete_enrollment_token(
    token_id: int,
    confirm_active: bool = Query(default=False),
    confirm_default: bool = Query(default=False),
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
):
    try:
        token = EnrollmentTokenService(db).delete(
            token_id,
            confirm_active=confirm_active,
            confirm_default=confirm_default,
        )
        audit_log(db, operator=operator, action=AuditAction.ENROLLMENT_TOKEN_DELETED, entity_type="enrollment_token", entity_id=token.id, details={"name": token.name, "status": token.status.value if hasattr(token.status, "value") else token.status})
        return token
    except ValueError as exc:
        detail = str(exc)
        if "not found" in detail.lower():
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)


@router.post("/verify", response_model=EnrollmentTokenVerifyResponse)
def verify_enrollment_token(
    payload: EnrollmentTokenVerifyRequest,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
):
    return EnrollmentTokenService(db).peek(payload.token)
