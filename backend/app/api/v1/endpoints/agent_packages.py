import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse

from app.core.auth import get_current_operator, require_team_permission
from app.models.operator import Operator, OperatorRole
from app.services.permission_service import DEPLOYMENT
from app.schemas.agent_package import AgentPackageActivationRequest, AgentPackageOut, AgentPackageUploadResponse
from app.services.agent_package_service import AgentPackageService
from app.services.audit_service import AuditAction, audit_log
from app.db.session import get_db
from sqlalchemy.orm import Session

router = APIRouter()
logger = logging.getLogger("techi.agent_packages")
PUBLIC_DOWNLOAD_PLATFORMS = {"windows", "windows-amd64", "windows-arm64"}

_require_deployment = require_team_permission(DEPLOYMENT)


@router.get("", response_model=list[AgentPackageOut])
def list_agent_packages(
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_deployment),
):
    include_inactive = operator.role in (OperatorRole.ADMIN.value, OperatorRole.OWNER.value)
    return AgentPackageService().list_packages(include_inactive=include_inactive)


@router.post("", response_model=AgentPackageUploadResponse)
def upload_agent_package(
    version: str = Form(...),
    platform: str = Form(...),
    file_type: str = Form(default="msi"),
    file: UploadFile = File(...),
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_deployment),
):
    try:
        package = AgentPackageService().upload(
            version=version,
            platform=platform,
            file_type=file_type,
            filename=file.filename or "",
            uploaded_by=operator.username,
            stream=file.file,
        )
        return AgentPackageUploadResponse(package=package)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{package_id}/active", response_model=AgentPackageOut)
def set_agent_package_active(
    package_id: str,
    payload: AgentPackageActivationRequest,
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_deployment),
    db: Session = Depends(get_db),
):
    try:
        package = AgentPackageService().set_active(package_id, payload.is_active)
        audit_log(
            db,
            operator=operator,
            action=AuditAction.AGENT_PACKAGE_ACTIVATED if payload.is_active else AuditAction.AGENT_PACKAGE_DEACTIVATED,
            entity_type="agent_package",
            entity_id=None,
            details={"package_id": package.id, "version": package.version, "platform": package.platform.value},
        )
        return package
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete("/{package_id}", response_model=AgentPackageOut)
def delete_agent_package(
    package_id: str,
    confirm_active: bool = False,
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_deployment),
    db: Session = Depends(get_db),
):
    try:
        package = AgentPackageService().delete(package_id, confirm_active=confirm_active)
        audit_log(
            db,
            operator=operator,
            action=AuditAction.AGENT_PACKAGE_DELETED,
            entity_type="agent_package",
            entity_id=None,
            details={"package_id": package.id, "version": package.version, "platform": package.platform.value},
        )
        return package
    except ValueError as exc:
        detail = str(exc)
        if "not found" in detail.lower():
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)


@router.get("/active-version", response_class=PlainTextResponse)
def get_active_windows_agent_version() -> PlainTextResponse:
    service = AgentPackageService()
    package = service.latest_active("windows-amd64", file_type="agent_binary") or service.latest_active("windows-amd64")
    if package is None:
        raise HTTPException(status_code=404, detail="No active package for platform")
    return PlainTextResponse(
        package.version,
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/agent-binary/download")
def download_active_agent_binary():
    """Public endpoint: returns the currently active agent_binary package for
    windows-amd64.  Used by the self_update command so the agent always fetches
    the binary that is marked active in the UI — no token required."""
    service = AgentPackageService()
    package = service.latest_active("windows-amd64", file_type="agent_binary")
    if package is None:
        raise HTTPException(status_code=404, detail="No active agent binary package for windows-amd64")
    path = service.package_path(package)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Package file not found")
    logger.info(
        "Agent binary download package_id=%s version=%s", package.id, package.version
    )
    return FileResponse(
        path,
        filename=package.filename,
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/agent-update-msi/download")
def download_active_agent_update_msi():
    """Public endpoint: returns the currently active agent_update_msi (Agent
    Update Bridge) package for windows-amd64.  Used by self_update payloads
    for legacy msiexec-based agents — no token required.  Kept separate from
    /platform/{platform}/download, which serves the combined bootstrap MSI."""
    service = AgentPackageService()
    package = service.latest_active("windows-amd64", file_type="agent_update_msi")
    if package is None:
        raise HTTPException(status_code=404, detail="No active agent update MSI package for windows-amd64")
    path = service.package_path(package)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Package file not found")
    logger.info(
        "Agent update MSI download package_id=%s version=%s", package.id, package.version
    )
    return FileResponse(
        path,
        filename=package.filename,
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/{package_id}/download")
def download_agent_package(package_id: str, operator: Operator = Depends(get_current_operator)):
    service = AgentPackageService()
    package = service.get(package_id)
    if package is None:
        raise HTTPException(status_code=404, detail="Package not found")
    if not package.is_active and operator.role not in (OperatorRole.ADMIN.value, OperatorRole.OWNER.value):
        raise HTTPException(status_code=403, detail="Inactive package downloads require admin role")
    path = service.package_path(package)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Package file not found")
    return FileResponse(path, filename=package.filename, media_type="application/octet-stream")


@router.get("/platform/{platform}/download")
def download_latest_active_agent_package(platform: str):
    if platform not in PUBLIC_DOWNLOAD_PLATFORMS:
        logger.warning("Rejected public agent package download for unsupported platform=%s", platform)
        raise HTTPException(status_code=400, detail="Unsupported public download platform")

    service = AgentPackageService()
    package = service.latest_active(platform, file_type="msi")
    if package is None:
        logger.info("Public agent package download returned no active package for platform=%s", platform)
        raise HTTPException(status_code=404, detail="No active package for platform")
    path = service.package_path(package)
    if not path.exists():
        logger.warning(
            "Public agent package download missing file package_id=%s platform=%s path=%s",
            package.id,
            platform,
            path,
        )
        raise HTTPException(status_code=404, detail="Package file not found")
    logger.info(
        "Public agent package download package_id=%s platform=%s version=%s",
        package.id,
        platform,
        package.version,
    )
    return FileResponse(
        path,
        filename=package.filename,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
