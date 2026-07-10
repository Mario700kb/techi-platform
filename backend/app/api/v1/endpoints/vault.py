"""Enterprise Credential Vault API (Phase 4, flag-gated).

With FEATURE_VAULT off every route returns 404 — the vault is invisible, not
"disabled": flag-off production is bit-identical to a build without it.
Role gates (until the Phase 6 permission matrix): list → operator+,
create/update/delete/reveal/usage → admin+; reveal additionally requires a
reason and is written to both the usage table and the audit log.
"""

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.platform_core.flags import feature_enabled
from app.schemas.vault import (
    VaultCredentialCreate,
    VaultCredentialOut,
    VaultCredentialUpdate,
    VaultRevealRequest,
    VaultRevealResponse,
    VaultUsageOut,
)
from app.services.audit_service import audit_log
from app.services.vault_service import VaultReferencedError, VaultScopeError, VaultService

logger = logging.getLogger(__name__)

router = APIRouter()

_require_operator = require_min_role(OperatorRole.OPERATOR.value)
_require_admin = require_min_role(OperatorRole.ADMIN.value)


def _require_vault_enabled() -> None:
    if not feature_enabled("FEATURE_VAULT"):
        raise HTTPException(status_code=404, detail="Not Found")


def _out(service: VaultService, credential) -> VaultCredentialOut:
    out = VaultCredentialOut.model_validate(credential)
    out.secret_hint = service.secret_hint(credential)
    return out


def _get_or_404(service: VaultService, credential_id: int):
    credential = service.get(credential_id)
    if credential is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    return credential


@router.get("", response_model=List[VaultCredentialOut], dependencies=[Depends(_require_vault_enabled)])
def list_credentials(
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_operator),
):
    service = VaultService(db)
    return [_out(service, credential) for credential in service.list()]


@router.post("", response_model=VaultCredentialOut, dependencies=[Depends(_require_vault_enabled)])
def create_credential(
    payload: VaultCredentialCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = VaultService(db)
    try:
        credential = service.create(payload, created_by=operator.username)
    except VaultScopeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    audit_log(
        db,
        operator=operator,
        action="vault_credential_created",
        entity_type="vault_credential",
        entity_id=credential.id,
        details={"name": credential.name, "scope": credential.scope_type},
    )
    return _out(service, credential)


@router.patch("/{credential_id}", response_model=VaultCredentialOut, dependencies=[Depends(_require_vault_enabled)])
def update_credential(
    credential_id: int,
    payload: VaultCredentialUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    rotated = payload.secret is not None
    credential = service.update(credential, payload, operator.username)
    audit_log(
        db,
        operator=operator,
        action="vault_credential_rotated" if rotated else "vault_credential_updated",
        entity_type="vault_credential",
        entity_id=credential.id,
        details={"name": credential.name},
    )
    return _out(service, credential)


@router.delete("/{credential_id}", status_code=204, dependencies=[Depends(_require_vault_enabled)])
def delete_credential(
    credential_id: int,
    force: bool = False,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    name = credential.name
    try:
        service.delete(credential, operator.username, force=force)
    except VaultReferencedError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Credential \"{name}\" is still referenced by: {', '.join(exc.references)}. "
                "Delete again with confirmation to override."
            ),
        )
    audit_log(
        db,
        operator=operator,
        action="vault_credential_deleted_forced" if force else "vault_credential_deleted",
        entity_type="vault_credential",
        entity_id=credential_id,
        details={"name": name},
    )


@router.post("/{credential_id}/reveal", response_model=VaultRevealResponse, dependencies=[Depends(_require_vault_enabled)])
def reveal_credential(
    credential_id: int,
    payload: VaultRevealRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    secret = service.reveal(credential, operator.username, payload.reason)
    audit_log(
        db,
        operator=operator,
        action="vault_credential_revealed",
        entity_type="vault_credential",
        entity_id=credential.id,
        details={"name": credential.name, "reason": payload.reason},
    )
    return VaultRevealResponse(
        id=credential.id, name=credential.name, username=credential.username, secret=secret
    )


@router.get("/{credential_id}/usage", response_model=List[VaultUsageOut], dependencies=[Depends(_require_vault_enabled)])
def credential_usage(
    credential_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_admin),
):
    service = VaultService(db)
    _get_or_404(service, credential_id)
    return service.usage(credential_id)
