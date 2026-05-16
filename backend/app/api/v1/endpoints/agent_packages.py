from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.auth import get_current_operator, require_min_role
from app.models.operator import Operator, OperatorRole
from app.schemas.agent_package import AgentPackageActivationRequest, AgentPackageOut, AgentPackageUploadResponse
from app.services.agent_package_service import AgentPackageService

router = APIRouter()


@router.get("", response_model=list[AgentPackageOut])
def list_agent_packages(operator: Operator = Depends(get_current_operator)):
    include_inactive = operator.role in (OperatorRole.ADMIN.value, OperatorRole.OWNER.value)
    return AgentPackageService().list_packages(include_inactive=include_inactive)


@router.post("", response_model=AgentPackageUploadResponse)
def upload_agent_package(
    version: str = Form(...),
    platform: str = Form(...),
    file: UploadFile = File(...),
    operator: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    try:
        package = AgentPackageService().upload(
            version=version,
            platform=platform,
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
    _: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
):
    try:
        return AgentPackageService().set_active(package_id, payload.is_active)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


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
def download_latest_active_agent_package(platform: str, _: Operator = Depends(get_current_operator)):
    service = AgentPackageService()
    package = service.latest_active(platform)
    if package is None:
        raise HTTPException(status_code=404, detail="No active package for platform")
    path = service.package_path(package)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Package file not found")
    return FileResponse(path, filename=package.filename, media_type="application/octet-stream")
