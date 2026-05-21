from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session
from urllib.parse import urlsplit, urlunsplit

from app.core.config import settings
from app.db.session import get_db
from app.schemas.enrollment_bootstrap import (
    AvailabilityProfile,
    EnrollmentBootstrapMode,
    EnrollmentBootstrapPlatform,
    EnrollmentBootstrapRequest,
)
from app.services.enrollment_bootstrap_service import EnrollmentBootstrapService
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.audit_service import AuditAction, system_audit_log

router = APIRouter()


def _normalize_https_url(url: str) -> str:
    raw = (url or "").strip().rstrip("/")
    if not raw:
        return raw
    parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
    return urlunsplit(("https", parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _public_backend_url(request: Request) -> str:
    configured_url = (settings.PUBLIC_BACKEND_URL or "").strip()
    if configured_url:
        return _normalize_https_url(configured_url)
    return _normalize_https_url(str(request.base_url))


def _trusted_domain_payload(*, request: Request, availability_profile: AvailabilityProfile) -> EnrollmentBootstrapRequest:
    return EnrollmentBootstrapRequest(
        mode=EnrollmentBootstrapMode.GPO,
        enrollment_token_id=None,
        backend_url=_public_backend_url(request),
        platform=EnrollmentBootstrapPlatform.WINDOWS,
        enrollment_token=None,
        rustdesk_manage_enabled=True,
        rustdesk_rendezvous_server=settings.RUSTDESK_SERVER_HOST,
        rustdesk_relay_server=settings.RUSTDESK_RELAY_HOST,
        rustdesk_key=settings.RUSTDESK_PUBLIC_KEY,
        rustdesk_default_password=settings.RUSTDESK_DEFAULT_PASSWORD,
        availability_profile=availability_profile,
        manage_power_policy=availability_profile == AvailabilityProfile.SERVER,
    )


def _trusted_domain_script_response(
    *,
    request: Request,
    db: Session,
    kind: str,
    availability_profile: AvailabilityProfile,
    filename: str,
) -> PlainTextResponse:
    token = EnrollmentTokenService(db).ensure_internal_bootstrap_token(
        kind=kind,
        expires_hours=settings.INTERNAL_BOOTSTRAP_TOKEN_EXPIRES_HOURS,
    )
    payload = _trusted_domain_payload(request=request, availability_profile=availability_profile)
    try:
        bootstrap = EnrollmentBootstrapService(db).generate(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    system_audit_log(
        db,
        action=AuditAction.BOOTSTRAP_SCRIPT_SERVED,
        entity_type="bootstrap",
        entity_id=token.id,
        details={
            "kind": kind,
            "remote_addr": request.client.host if request.client else None,
            "trusted_domain_allowlist": settings.TRUSTED_DOMAIN_ALLOWLIST,
            "internal_token_prefix": token.token_prefix,
        },
    )
    return PlainTextResponse(
        bootstrap.bootstrap_script,
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'inline; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/windows.ps1", response_class=PlainTextResponse)
def windows_bootstrap_script(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
) -> PlainTextResponse:
    token = token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="token is required")

    token_service = EnrollmentTokenService(db)
    try:
        token_record = token_service.get_active_token_by_plaintext(token)
    except ValueError as exc:
        detail = str(exc)
        if detail in {"invalid", "expired", "revoked", "used"}:
            raise HTTPException(status_code=400, detail=f"Enrollment token is {detail}")
        raise HTTPException(status_code=400, detail=detail)

    payload = EnrollmentBootstrapRequest(
        mode=EnrollmentBootstrapMode.TOKEN,
        enrollment_token_id=token_record.id,
        backend_url=_public_backend_url(request),
        platform=EnrollmentBootstrapPlatform.WINDOWS,
        enrollment_token=token,
        rustdesk_manage_enabled=True,
        rustdesk_rendezvous_server=settings.RUSTDESK_SERVER_HOST,
        rustdesk_relay_server=settings.RUSTDESK_RELAY_HOST,
        rustdesk_key=settings.RUSTDESK_PUBLIC_KEY,
        rustdesk_default_password=settings.RUSTDESK_DEFAULT_PASSWORD,
        availability_profile=AvailabilityProfile.WORKSTATION,
        manage_power_policy=False,
    )
    try:
        bootstrap = EnrollmentBootstrapService(db).generate(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return PlainTextResponse(
        bootstrap.bootstrap_script,
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="techi-bootstrap.ps1"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/domain.ps1", response_class=PlainTextResponse)
def trusted_domain_bootstrap_script(
    request: Request,
    db: Session = Depends(get_db),
) -> PlainTextResponse:
    return _trusted_domain_script_response(
        request=request,
        db=db,
        kind="domain",
        availability_profile=AvailabilityProfile.SERVER,
        filename="techi-domain-bootstrap.ps1",
    )


@router.get("/gpo.ps1", response_class=PlainTextResponse)
def trusted_domain_gpo_bootstrap_script(
    request: Request,
    db: Session = Depends(get_db),
) -> PlainTextResponse:
    return _trusted_domain_script_response(
        request=request,
        db=db,
        kind="gpo",
        availability_profile=AvailabilityProfile.WORKSTATION,
        filename="techi-gpo-bootstrap.ps1",
    )
