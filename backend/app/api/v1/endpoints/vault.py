"""Enterprise Credential Vault API (Phase 4, flag-gated; extended 2026-07-10
into a full enterprise secret manager — types/purpose/scope/assignments/
lifecycle/test-connection/granular RBAC — see docs/reference/OPERATOR-MANUAL.md
§20).

With FEATURE_VAULT off every route returns 404 — the vault is invisible, not
"disabled": flag-off production is bit-identical to a build without it.

RBAC: admin+ has full access to every route below (unchanged floor). A team
can ADDITIONALLY grant one of the granular vault_* permissions to a
non-admin operator via `_vault_gate` — this only ever adds access, it never
narrows what admin/owner already have.
"""

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import ROLE_ORDER, get_current_operator, get_operator_permissions
from app.core.time import utcnow
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device
from app.models.operator import Operator, OperatorRole
from app.platform_core.flags import feature_enabled
from app.platform_core.vault_credential_types import list_types
from app.schemas.vault import (
    VaultAssignmentCreate,
    VaultAssignmentOut,
    VaultCredentialCreate,
    VaultCredentialOut,
    VaultCredentialTypeOut,
    VaultCredentialUpdate,
    VaultFieldSpecOut,
    VaultRevealRequest,
    VaultRevealResponse,
    VaultTestResult,
    VaultUsageOut,
)
from app.services.audit_service import audit_log
from app.services.permission_service import (
    VAULT_ASSIGN,
    VAULT_CREATE,
    VAULT_DELETE,
    VAULT_EDIT,
    VAULT_REVEAL,
    VAULT_TEST,
    VAULT_VIEW,
)
from app.services.vault_service import VaultCredentialTypeError, VaultReferencedError, VaultScopeError, VaultService

logger = logging.getLogger(__name__)

router = APIRouter()


def _require_vault_enabled() -> None:
    if not feature_enabled("FEATURE_VAULT"):
        raise HTTPException(status_code=404, detail="Not Found")


def _vault_gate(min_role: str, perm_key: str):
    """Passes if the operator's role already meets `min_role` (today's
    behavior, unchanged) OR their effective team permissions include
    `perm_key`. Purely additive — never blocks anyone who could get through
    on role alone."""

    def dependency(
        operator: Operator = Depends(get_current_operator),
        db: Session = Depends(get_db),
    ) -> Operator:
        if ROLE_ORDER.get(operator.role, -1) >= ROLE_ORDER.get(min_role, 99):
            return operator
        perms = get_operator_permissions(operator, db)
        if perms is not None and perm_key in perms:
            return operator
        raise HTTPException(status_code=403, detail=f"Permission denied: {perm_key}")

    return dependency


_require_view = _vault_gate(OperatorRole.OPERATOR.value, VAULT_VIEW)
_require_create = _vault_gate(OperatorRole.ADMIN.value, VAULT_CREATE)
_require_edit = _vault_gate(OperatorRole.ADMIN.value, VAULT_EDIT)
_require_delete = _vault_gate(OperatorRole.ADMIN.value, VAULT_DELETE)
_require_reveal = _vault_gate(OperatorRole.ADMIN.value, VAULT_REVEAL)
_require_test = _vault_gate(OperatorRole.ADMIN.value, VAULT_TEST)
_require_assign = _vault_gate(OperatorRole.ADMIN.value, VAULT_ASSIGN)


def _out(service: VaultService, credential) -> VaultCredentialOut:
    enriched = service.enrich(credential)
    out = VaultCredentialOut.model_validate(credential)
    out.secret_hint = service.secret_hint(credential)
    out.credential_metadata = enriched["metadata"]
    out.lifecycle_status = enriched["lifecycle_status"]
    out.is_referenced = enriched["is_referenced"]
    out.reference_count = enriched["reference_count"]
    out.references = enriched["references"]
    out.consumer_status = enriched["consumer_status"]
    out.future_consumers = enriched["future_consumers"]
    out.used_by = enriched["used_by"]
    return out


def _assignment_out(db: Session, assignment) -> VaultAssignmentOut:
    out = VaultAssignmentOut.model_validate(assignment)
    if assignment.client_id is not None:
        client = db.query(Client).filter(Client.id == assignment.client_id).first()
        out.client_name = client.name if client else None
    if assignment.device_id is not None:
        device = db.query(Device).filter(Device.id == assignment.device_id).first()
        out.device_name = (device.display_name or device.hostname) if device else None
    return out


def _get_or_404(service: VaultService, credential_id: int):
    credential = service.get(credential_id)
    if credential is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    return credential


@router.get("/types", response_model=List[VaultCredentialTypeOut], dependencies=[Depends(_require_vault_enabled)])
def list_credential_types(_: Operator = Depends(_require_view)):
    return [
        VaultCredentialTypeOut(
            id=t.id, label=t.label, icon=t.icon, category=t.category,
            metadata_fields=[VaultFieldSpecOut(**f.__dict__) for f in t.metadata_fields],
            secret_fields=[VaultFieldSpecOut(**f.__dict__) for f in t.secret_fields],
            requires_username=t.requires_username, requires_secret=t.requires_secret,
            future_consumers=list(t.future_consumers), legacy=t.legacy,
        )
        for t in list_types()
    ]


@router.get("", response_model=List[VaultCredentialOut], dependencies=[Depends(_require_vault_enabled)])
def list_credentials(
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_view),
):
    service = VaultService(db)
    return [_out(service, credential) for credential in service.list()]


@router.post("", response_model=VaultCredentialOut, dependencies=[Depends(_require_vault_enabled)])
def create_credential(
    payload: VaultCredentialCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_create),
):
    service = VaultService(db)
    try:
        credential = service.create(payload, created_by=operator.username)
    except (VaultScopeError, VaultCredentialTypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    audit_log(
        db,
        operator=operator,
        action="vault_credential_created",
        entity_type="vault_credential",
        entity_id=credential.id,
        details={"name": credential.name, "scope": credential.scope_type, "type": credential.credential_type},
    )
    return _out(service, credential)


@router.patch("/{credential_id}", response_model=VaultCredentialOut, dependencies=[Depends(_require_vault_enabled)])
def update_credential(
    credential_id: int,
    payload: VaultCredentialUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_edit),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    rotated = payload.secret is not None or bool(payload.secret_fields)
    try:
        credential = service.update(credential, payload, operator.username)
    except (VaultScopeError, VaultCredentialTypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    audit_log(
        db,
        operator=operator,
        action="vault_credential_rotated" if rotated else "vault_credential_updated",
        entity_type="vault_credential",
        entity_id=credential.id,
        details={"name": credential.name},
    )
    return _out(service, credential)


@router.post("/{credential_id}/status", response_model=VaultCredentialOut, dependencies=[Depends(_require_vault_enabled)])
def set_credential_status(
    credential_id: int,
    status: str,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_edit),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    try:
        credential = service.set_status(credential, status, operator.username)
    except VaultScopeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    audit_log(
        db, operator=operator,
        action="vault_credential_enabled" if status == "active" else "vault_credential_disabled",
        entity_type="vault_credential", entity_id=credential.id, details={"name": credential.name},
    )
    return _out(service, credential)


@router.delete("/{credential_id}", status_code=204, dependencies=[Depends(_require_vault_enabled)])
def delete_credential(
    credential_id: int,
    force: bool = False,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_delete),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    name = credential.name
    try:
        service.delete(credential, operator.username, force=force)
    except VaultReferencedError as exc:
        audit_log(
            db, operator=operator, action="vault_credential_delete_blocked",
            entity_type="vault_credential", entity_id=credential_id,
            details={"name": name, "references": exc.references},
        )
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
    operator: Operator = Depends(_require_reveal),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    secret_fields = service.reveal(credential, operator.username, payload.reason)
    audit_log(
        db,
        operator=operator,
        action="vault_credential_revealed",
        entity_type="vault_credential",
        entity_id=credential.id,
        details={"name": credential.name, "reason": payload.reason},
    )
    return VaultRevealResponse(
        id=credential.id, name=credential.name, username=credential.username, secret_fields=secret_fields
    )


@router.post("/{credential_id}/test", response_model=VaultTestResult, dependencies=[Depends(_require_vault_enabled)])
def test_credential(
    credential_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_test),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    status, message = service.test_connection(credential)
    if status != "unsupported":
        credential.last_tested_at = utcnow()
        credential.last_test_status = status
        db.commit()
    audit_log(
        db, operator=operator,
        action="vault_credential_tested" if status == "success" else "vault_credential_test_failed",
        entity_type="vault_credential", entity_id=credential.id,
        details={"name": credential.name, "status": status},
    )
    return VaultTestResult(status=status, message=message)


@router.get("/{credential_id}/usage", response_model=List[VaultUsageOut], dependencies=[Depends(_require_vault_enabled)])
def credential_usage(
    credential_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_view),
):
    service = VaultService(db)
    _get_or_404(service, credential_id)
    return service.usage(credential_id)


@router.get(
    "/{credential_id}/assignments", response_model=List[VaultAssignmentOut],
    dependencies=[Depends(_require_vault_enabled)],
)
def list_assignments(
    credential_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_view),
):
    service = VaultService(db)
    _get_or_404(service, credential_id)
    return [_assignment_out(db, a) for a in service.list_assignments(credential_id)]


@router.post(
    "/{credential_id}/assignments", response_model=VaultAssignmentOut,
    dependencies=[Depends(_require_vault_enabled)],
)
def add_assignment(
    credential_id: int,
    payload: VaultAssignmentCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_assign),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    if payload.client_id is not None and db.query(Client).filter(Client.id == payload.client_id).first() is None:
        raise HTTPException(status_code=404, detail="Client not found")
    if payload.device_id is not None and db.query(Device).filter(Device.id == payload.device_id).first() is None:
        raise HTTPException(status_code=404, detail="Device not found")
    try:
        assignment = service.add_assignment(credential_id, payload.client_id, payload.device_id, operator.username)
    except VaultScopeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    audit_log(
        db, operator=operator, action="vault_credential_assigned",
        entity_type="vault_credential", entity_id=credential.id,
        details={"name": credential.name, "client_id": payload.client_id, "device_id": payload.device_id},
    )
    return _assignment_out(db, assignment)


@router.delete(
    "/{credential_id}/assignments/{assignment_id}", status_code=204,
    dependencies=[Depends(_require_vault_enabled)],
)
def remove_assignment(
    credential_id: int,
    assignment_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_assign),
):
    service = VaultService(db)
    credential = _get_or_404(service, credential_id)
    assignment = next((a for a in service.list_assignments(credential_id) if a.id == assignment_id), None)
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    service.remove_assignment(assignment, operator.username)
    audit_log(
        db, operator=operator, action="vault_credential_unassigned",
        entity_type="vault_credential", entity_id=credential.id,
        details={"name": credential.name, "assignment_id": assignment_id},
    )
