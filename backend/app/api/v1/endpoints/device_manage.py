"""Operator actions on a Windows PC's processes, services and software from
the device page: end a process, start/stop/restart a service, uninstall an
app (agent 2.1.41).

A request names what the console showed. It is checked against the device's
last inventory here — an API caller cannot name a PID, service or uninstall
entry the device never reported — and again on the PC by the agent before it
acts. Each becomes a remote action pushed over the live channel. Ending a
process and controlling a service need the operator role; an uninstall cannot
be undone, so it needs an administrator and a current two-factor code."""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.v1.endpoints.devices import get_scoped_device
from app.core.auth import get_operator_permissions, require_min_role, require_roles
from app.db.session import get_db
from app.models.device import Device
from app.models.operator import Operator, OperatorRole
from app.schemas.remote_action import RemoteActionResponse
from app.services.action_push import push_action_if_connected
from app.services.audit_service import AuditAction, audit_log
from app.services.device_inventory_service import DeviceInventoryService
from app.services.permission_service import DEPLOYMENT, DIAGNOSTICS
from app.services.remote_action_service import ActionConflictError, RemoteActionService
from app.services.version_service import compare_versions

router = APIRouter()

MIN_AGENT_VERSION = "2.1.41"

# The agent holds the full lists (actions_manage_windows.go); these are the
# ones the console must never offer, refused here too.
PROTECTED_PROCESSES = frozenset({
    "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe",
    "lsass.exe", "lsaiso.exe", "svchost.exe", "dwm.exe", "msmpeng.exe",
    "techi-agent.exe", "techi-agent-watchdog.exe", "techi remote support.exe", "rustdesk.exe",
})
PROTECTED_SERVICES = frozenset({
    "techiagent", "techi remote support", "rpcss", "rpceptmapper", "dcomlaunch", "lsm", "samss",
    "plugplay", "power", "brokerinfrastructure", "coremessagingregistrar", "systemeventsbroker",
    "schedule", "eventlog", "profsvc", "gpsvc", "nsi", "dhcp", "bfe", "mpssvc",
})

KILL_TIMEOUT_SECONDS = 60
SERVICE_TIMEOUT_SECONDS = 180
UNINSTALL_TIMEOUT_SECONDS = 1200


class KillProcessRequest(BaseModel):
    pid: int = Field(gt=4)
    name: str = Field(min_length=1, max_length=260)


class ServiceControlRequest(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    operation: Literal["start", "stop", "restart"]


class UninstallSoftwareRequest(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    uninstall_key: str = Field(min_length=1, max_length=512)
    mfa_code: Optional[str] = Field(default=None, max_length=12)


def is_protected_software(name: str) -> bool:
    lower = name.strip().lower()
    return lower == "techi agent" or lower.startswith("techi remote support") or lower.startswith("techi endpoint")


def _require_manageable(device: Device) -> None:
    if (device.platform or "").strip().lower() != "windows":
        raise HTTPException(status_code=409, detail="Processes, services and software are managed on Windows devices only")
    if compare_versions(device.agent_version, MIN_AGENT_VERSION) not in ("current", "ahead"):
        raise HTTPException(
            status_code=409,
            detail=f"Needs agent {MIN_AGENT_VERSION} or later (this device runs {device.agent_version or 'an unknown version'}); update the agent first",
        )


def _require_permission(operator: Operator, db: Session, permission: str) -> None:
    effective = get_operator_permissions(operator, db)
    if effective is not None and permission not in effective:
        raise HTTPException(status_code=403, detail=f"Permission denied: {permission}")


def _queue(db: Session, operator: Operator, device: Device, action_type: str, parameters: dict,
           timeout_seconds: int, audit_details: dict) -> RemoteActionResponse:
    try:
        action = RemoteActionService(db).queue_management_action(
            device.id, action_type, parameters,
            created_by=operator.username, execution_timeout_seconds=timeout_seconds,
        )
    except ActionConflictError as exc:
        raise HTTPException(status_code=409, detail=exc.detail())
    audit_log(db, operator=operator, action=AuditAction.ACTION_QUEUED, entity_type="remote_action", entity_id=action.id,
              details={"device_id": device.id, "action_type": action_type, **audit_details})
    push_action_if_connected(device.id, action, RemoteActionService(db))
    return RemoteActionResponse.model_validate(action)


@router.post("/devices/{device_id}/processes/kill", response_model=RemoteActionResponse)
def kill_process(
    payload: KillProcessRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
):
    _require_permission(operator, db, DIAGNOSTICS)
    _require_manageable(device)
    name = payload.name.strip()
    if name.lower() in PROTECTED_PROCESSES:
        raise HTTPException(status_code=403, detail=f"{name} is protected and cannot be ended from the console")
    listed = DeviceInventoryService(db).get_inventory(device.id).processes
    if not any(p.pid == payload.pid and p.name.lower() == name.lower() for p in listed):
        raise HTTPException(status_code=409, detail=f"{name} (PID {payload.pid}) is not in the device's process list any more; refresh it")
    return _queue(db, operator, device, "kill_process", {"pid": payload.pid, "name": name},
                  KILL_TIMEOUT_SECONDS, {"pid": payload.pid, "name": name})


@router.post("/devices/{device_id}/services/control", response_model=RemoteActionResponse)
def control_service(
    payload: ServiceControlRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
):
    _require_permission(operator, db, DIAGNOSTICS)
    _require_manageable(device)
    name = payload.name.strip()
    if payload.operation != "start" and name.lower() in PROTECTED_SERVICES:
        raise HTTPException(status_code=403, detail=f"{name} keeps Windows or the agent running; it cannot be stopped or restarted from the console")
    listed = DeviceInventoryService(db).get_inventory(device.id).services
    if not any(s.name.lower() == name.lower() for s in listed):
        raise HTTPException(status_code=409, detail=f"Service {name} is not in the device's service list; refresh it")
    return _queue(db, operator, device, "service_control", {"name": name, "operation": payload.operation},
                  SERVICE_TIMEOUT_SECONDS, {"service": name, "operation": payload.operation})


@router.post("/devices/{device_id}/software/uninstall", response_model=RemoteActionResponse)
def uninstall_software(
    payload: UninstallSoftwareRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
    device: Device = Depends(get_scoped_device),
):
    _require_permission(operator, db, DEPLOYMENT)
    _require_manageable(device)
    name = payload.name.strip()
    if is_protected_software(name):
        raise HTTPException(status_code=403, detail=f"{name} is part of TECHI and cannot be uninstalled from the console")
    listed = DeviceInventoryService(db).get_inventory(device.id).software
    entry = next((s for s in listed if s.uninstall_key == payload.uninstall_key and s.name == name), None)
    if entry is None:
        raise HTTPException(status_code=409, detail=f"{name} is not in the device's software list any more; refresh it")
    if entry.uninstall not in ("msi", "quiet"):
        raise HTTPException(status_code=409, detail=f"{name} has no silent uninstall; remove it over Remote Support")
    _require_uninstall_step_up(db, operator, device, payload.mfa_code, name)
    return _queue(db, operator, device, "uninstall_software", {"name": name, "uninstall_key": payload.uninstall_key},
                  UNINSTALL_TIMEOUT_SECONDS, {"name": name, "method": entry.uninstall})


def _require_uninstall_step_up(db: Session, operator: Operator, device: Device, code: Optional[str], name: str) -> None:
    """An uninstall is asked with a current two-factor code, whatever the
    operator's session says (as deleting a device or the administrator
    PowerShell)."""
    from app.services.mfa_service import MfaService

    reason = None
    if not operator.mfa_enabled:
        reason = "mfa_not_enabled"
    elif not (code or "").strip() or MfaService(db).verify(operator, code.strip().replace(" ", "")) is None:
        reason = "mfa_invalid"
    if reason is None:
        return
    audit_log(db, operator=operator, action=AuditAction.SOFTWARE_UNINSTALL_DENIED, entity_type="device",
              entity_id=device.id, details={"reason": reason, "name": name, "hostname": device.hostname})
    detail = (
        "Turn on two-factor authentication to uninstall software."
        if reason == "mfa_not_enabled" else "Enter a current two-factor code to uninstall this app."
    )
    raise HTTPException(status_code=403, detail={"code": reason, "detail": detail})
