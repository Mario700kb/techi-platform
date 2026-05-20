from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

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

router = APIRouter()


def _public_backend_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


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
