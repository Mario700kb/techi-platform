from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_min_role, require_team_permission
from app.core.config import settings
from app.core.scope import AllowedScope, device_in_scope
from app.core.time import utcnow
from app.db.session import get_db
from app.models.device import Device, DeviceType
from app.models.operator import Operator, OperatorRole
from app.schemas.remote_action import ActionType, RemoteActionCreate, RemoteActionResponse
from app.services import agent_config_service
from app.services.audit_service import AuditAction, audit_log
from app.services.permission_service import DEPLOYMENT, REINSTALL_REMOTE_SUPPORT, REMOTE_SUPPORT_CONNECT, REMOTE_SUPPORT_MANAGE
from app.services.device_service import DeviceService
from app.services.remote_action_service import RemoteActionService
from app.services.remote_support_password_service import RemoteSupportPasswordService

router = APIRouter(dependencies=[Depends(get_current_operator)])

# Heartbeat thresholds (seconds)
_ONLINE_TTL = 90
_WARNING_TTL = 300


# ------------------------------------------------------------------ #
# Status computation                                                   #
# ------------------------------------------------------------------ #

class RemoteSupportStatus(str, Enum):
    ONLINE = "online"
    WARNING = "warning"
    OFFLINE = "offline"


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def compute_remote_support_status(device: Device) -> RemoteSupportStatus:
    if not device.last_seen:
        return RemoteSupportStatus.OFFLINE

    age = (_ensure_utc(utcnow()) - _ensure_utc(device.last_seen)).total_seconds()

    has_valid_id = bool(device.rustdesk_id and device.rustdesk_id.strip())
    service_running = device.rustdesk_status == "running"
    installed = device.rustdesk_install_status == "installed"

    if age > _WARNING_TTL:
        return RemoteSupportStatus.OFFLINE
    if age > _ONLINE_TTL:
        return RemoteSupportStatus.WARNING
    # Age <= 90s
    if service_running and has_valid_id and installed:
        return RemoteSupportStatus.ONLINE
    return RemoteSupportStatus.WARNING


# ------------------------------------------------------------------ #
# Response schema                                                      #
# ------------------------------------------------------------------ #

class RemoteSupportDevice(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    device_id: int
    hostname: Optional[str]
    current_user: Optional[str]
    domain: Optional[str]
    techi_remote_id: Optional[str]
    public_ip: Optional[str]
    local_ip: Optional[str]
    platform: Optional[str]
    device_type: Optional[str]
    remote_support_status: RemoteSupportStatus
    service_status: str
    install_status: str
    last_seen: Optional[datetime]
    app_version: Optional[str]
    install_path: Optional[str]
    repair_count: int
    last_repair_at: Optional[datetime]
    client_id: Optional[int]
    group_id: Optional[int]


class ConnectUrlResponse(BaseModel):
    device_id: int
    techi_remote_id: str
    connect_url: str


class RemoteSupportPasswordResponse(BaseModel):
    device_id: int
    password: Optional[str] = None
    source: Optional[str] = None
    updated_at: Optional[datetime] = None
    desired_generation: int = 0
    applied_generation: int = 0
    apply_status: str = "unknown"
    failure_reason: Optional[str] = None


class SetRemoteSupportPasswordRequest(BaseModel):
    password: str


def _device_to_rs(device: Device) -> RemoteSupportDevice:
    return RemoteSupportDevice(
        device_id=device.id,
        hostname=device.hostname,
        current_user=device.current_user,
        domain=device.domain,
        techi_remote_id=device.rustdesk_id,
        public_ip=device.public_ip,
        local_ip=device.local_ip,
        platform=device.platform,
        device_type=device.device_type.value if device.device_type else None,
        remote_support_status=compute_remote_support_status(device),
        service_status=device.rustdesk_status or "unknown",
        install_status=device.rustdesk_install_status or "unknown",
        last_seen=device.last_seen,
        app_version=device.rustdesk_version,
        install_path=device.rustdesk_install_path,
        repair_count=device.rustdesk_repair_count or 0,
        last_repair_at=device.rustdesk_last_repair_at,
        client_id=device.client_id,
        group_id=device.group_id,
    )


def _build_connect_url(remote_id: str, password: Optional[str]) -> str:
    encoded_id = quote(remote_id, safe="")
    connect_url = f"techiremotesupport://{encoded_id}"
    policy = agent_config_service.get_policy()
    password = (password or "").strip()
    if policy["remote_support_managed_password_enabled"] and password:
        connect_url += f"?password={quote(password, safe='')}"
    return connect_url


def _connect_url_response_for_device(device: Device, db: Session) -> ConnectUrlResponse:
    remote_id = (device.rustdesk_id or "").strip()
    if not remote_id:
        raise HTTPException(
            status_code=422,
            detail="Device does not have a valid TECHI Remote Support ID — cannot connect",
        )
    if device.remote_support_apply_status != "applied":
        raise HTTPException(
            status_code=409,
            detail="Remote Support credential is not confirmed applied on this device",
        )
    password = RemoteSupportPasswordService(db).get_active_plaintext(device)
    if not password or device.remote_support_active_generation != device.remote_support_applied_generation:
        raise HTTPException(status_code=409, detail="Remote Support credential state is inconsistent")
    return ConnectUrlResponse(
        device_id=device.id,
        techi_remote_id=remote_id,
        connect_url=_build_connect_url(remote_id, password),
    )


# ------------------------------------------------------------------ #
# Scope helper                                                         #
# ------------------------------------------------------------------ #

def _get_device(
    device_id: int,
    db: Session,
    scope: Optional[AllowedScope],
) -> Device:
    device = DeviceService(db).get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if not device_in_scope(device.client_id, device.group_id, device.id, scope):
        raise HTTPException(status_code=404, detail="Device not found")
    return device


# ------------------------------------------------------------------ #
# Endpoints                                                            #
# ------------------------------------------------------------------ #

class RustDeskConfigResponse(BaseModel):
    server_host: str
    relay_host: str
    public_key: str


@router.get("/config", response_model=RustDeskConfigResponse)
def get_remote_support_config():
    return RustDeskConfigResponse(
        server_host=settings.RUSTDESK_SERVER_HOST,
        relay_host=settings.RUSTDESK_RELAY_HOST,
        public_key=settings.RUSTDESK_PUBLIC_KEY,
    )


@router.get("/devices", response_model=List[RemoteSupportDevice])
def list_remote_support_devices(
    *,
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    status: Optional[RemoteSupportStatus] = Query(default=None),
    domain: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    client_id: Optional[int] = Query(default=None),
    group_id: Optional[int] = Query(default=None),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=200, le=1000),
):
    """List all devices that have TECHI Remote Support, with computed status."""
    query = (
        db.query(Device)
        .filter(Device.is_archived == False)
        .filter(Device.rustdesk_install_status != "not_installed")
    )

    if client_id is not None:
        query = query.filter(Device.client_id == client_id)
    if group_id is not None:
        query = query.filter(Device.group_id == group_id)
    if domain:
        query = query.filter(Device.domain.ilike(f"%{domain}%"))
    if search:
        term = f"%{search}%"
        from sqlalchemy import or_
        query = query.filter(
            or_(
                Device.hostname.ilike(term),
                Device.current_user.ilike(term),
                Device.domain.ilike(term),
                Device.rustdesk_id.ilike(term),
                Device.public_ip.ilike(term),
            )
        )

    devices: List[Device] = query.offset(skip).limit(limit).all()

    result = []
    for d in devices:
        if scope is not None and not device_in_scope(d.client_id, d.group_id, d.id, scope):
            continue
        rs = _device_to_rs(d)
        if status is not None and rs.remote_support_status != status:
            continue
        result.append(rs)

    return result


@router.get("/devices/{device_id}", response_model=RemoteSupportDevice)
def get_remote_support_device(
    *,
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
):
    """Get remote support status for a single device."""
    device = _get_device(device_id, db, scope)
    return _device_to_rs(device)


@router.get("/devices/{device_id}/connect-url", response_model=ConnectUrlResponse)
def get_connect_url(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    _perm: None = Depends(require_team_permission(REMOTE_SUPPORT_CONNECT)),
    device_id: int,
):
    """Return the techiremotesupport:// protocol URL for connecting to this device."""
    device = _get_device(device_id, db, scope)

    # A stale TechiAgent heartbeat does not prove TECHI Remote Support itself is
    # unreachable: it is a separate Windows service and may still be registered
    # with the rendezvous server.  If we have a valid remote ID, return the
    # protocol URL and let the native client attempt the session.
    status = compute_remote_support_status(device)
    response = _connect_url_response_for_device(device, db)

    audit_log(
        db,
        operator=operator,
        action=AuditAction.REMOTE_CONNECT,
        entity_type="device",
        entity_id=device_id,
        details={"techi_remote_id": response.techi_remote_id, "remote_support_status": status.value},
    )

    return response


@router.get("/devices/{device_id}/password", response_model=RemoteSupportPasswordResponse)
def get_remote_support_password(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
):
    """Reveal this device's per-device TECHI Remote Support password. Audited.
    Owner/admin only — operators must not see the plaintext password."""
    device = _get_device(device_id, db, scope)
    svc = RemoteSupportPasswordService(db)
    password = svc.get_active_plaintext(device)
    if not password:
        raise HTTPException(status_code=409, detail="No confirmed applied Remote Support credential is available")
    audit_log(
        db,
        operator=operator,
        action=AuditAction.REMOTE_CONNECT,
        entity_type="device",
        entity_id=device_id,
        details={"action": "reveal_remote_support_password"},
    )
    return RemoteSupportPasswordResponse(
        device_id=device.id,
        password=password,
        source=device.remote_support_password_source,
        updated_at=device.remote_support_password_updated_at,
        desired_generation=device.remote_support_desired_generation or 0,
        applied_generation=device.remote_support_applied_generation or 0,
        apply_status=device.remote_support_apply_status or "unknown",
        failure_reason=device.remote_support_failure_reason,
    )


@router.post("/devices/{device_id}/password", response_model=RemoteSupportPasswordResponse)
def set_remote_support_password(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
    body: SetRemoteSupportPasswordRequest,
):
    """Create a desired custom generation. It is not active until Agent ACK."""
    device = _get_device(device_id, db, scope)
    svc = RemoteSupportPasswordService(db)
    try:
        password = svc.set_custom(device, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_QUEUED,
        entity_type="device",
        entity_id=device_id,
        details={"action": "set_remote_support_password", "source": "custom"},
    )
    return RemoteSupportPasswordResponse(
        device_id=device.id, password=password, source="custom",
        updated_at=device.remote_support_desired_created_at,
        desired_generation=device.remote_support_desired_generation,
        applied_generation=device.remote_support_applied_generation,
        apply_status=device.remote_support_apply_status,
    )


@router.post("/devices/{device_id}/password/regenerate", response_model=RemoteSupportPasswordResponse)
def regenerate_remote_support_password(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    device_id: int,
):
    """Generate a fresh unique per-device password. Applied on next heartbeat."""
    device = _get_device(device_id, db, scope)
    svc = RemoteSupportPasswordService(db)
    password = svc.regenerate(device)
    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_QUEUED,
        entity_type="device",
        entity_id=device_id,
        details={"action": "regenerate_remote_support_password", "source": "generated"},
    )
    return RemoteSupportPasswordResponse(
        device_id=device.id, password=password, source="generated",
        updated_at=device.remote_support_desired_created_at,
        desired_generation=device.remote_support_desired_generation,
        applied_generation=device.remote_support_applied_generation,
        apply_status=device.remote_support_apply_status,
    )


@router.post("/devices/{device_id}/restart-service", response_model=RemoteActionResponse)
def restart_remote_support_service(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    _perm: None = Depends(require_team_permission(REMOTE_SUPPORT_MANAGE)),
    device_id: int,
):
    """Queue a restart of the TECHI Remote Support service on the device."""
    device = _get_device(device_id, db, scope)

    try:
        action = RemoteActionService(db).queue_action(
            device_id,
            RemoteActionCreate(
                action_type=ActionType.RESTART_RUSTDESK,
                created_by=operator.username,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_QUEUED,
        entity_type="remote_action",
        entity_id=action.id,
        details={
            "device_id": device_id,
            "action_type": action.action_type,
            "source": "remote_support",
        },
    )
    return RemoteActionResponse.model_validate(action)


@router.post("/devices/{device_id}/deploy", response_model=RemoteActionResponse)
def deploy_remote_support(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    _perm: None = Depends(require_team_permission(DEPLOYMENT)),
    device_id: int,
    force_reinstall: bool = False,
):
    """Queue a deploy / upgrade of TECHI Remote Support on the device."""
    _get_device(device_id, db, scope)

    try:
        action = RemoteActionService(db).queue_action(
            device_id,
            RemoteActionCreate(
                action_type=ActionType.DEPLOY_REMOTE_SUPPORT,
                parameters={
                    "msi_url": "https://rdp.techi.com.al/downloads/TECHI-Remote-Support-1.4.6.msi",
                    "msi_version": "1.4.6",
                    "product_guid": "{74CEDF4A-E226-4151-BC7A-5154F0BC9E79}",
                    "rendezvous_server": "139.162.158.208",
                    "key": "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw=",
                    "force_reinstall": force_reinstall,
                },
                created_by=operator.username,
                execution_timeout_seconds=600,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_QUEUED,
        entity_type="remote_action",
        entity_id=action.id,
        details={
            "device_id": device_id,
            "action_type": action.action_type,
            "source": "remote_support",
            "force_reinstall": force_reinstall,
        },
    )
    return RemoteActionResponse.model_validate(action)


@router.post("/devices/{device_id}/repair-config", response_model=RemoteActionResponse)
def repair_remote_support_config(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    _perm: None = Depends(require_team_permission(REMOTE_SUPPORT_MANAGE)),
    device_id: int,
):
    """Queue a config repair for TECHI Remote Support (rewrites TOML + restarts service)."""
    device = _get_device(device_id, db, scope)

    try:
        action = RemoteActionService(db).queue_action(
            device_id,
            RemoteActionCreate(
                action_type=ActionType.REPAIR_CONFIG_RUSTDESK,
                created_by=operator.username,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    audit_log(
        db,
        operator=operator,
        action=AuditAction.ACTION_QUEUED,
        entity_type="remote_action",
        entity_id=action.id,
        details={
            "device_id": device_id,
            "action_type": action.action_type,
            "source": "remote_support",
        },
    )
    return RemoteActionResponse.model_validate(action)
