from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_min_role, require_roles, require_team_permission
from app.core.scope import AllowedScope, device_in_scope
from app.db.session import get_db
from app.models.device import Device, DeviceFreshnessState, DeviceStatus, DeviceType
from app.models.operator import Operator, OperatorRole
from app.schemas.activity import ActivityEvent
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import (
    Device as DeviceSchema,
    DeviceClientAssignment,
    DeviceCreate,
    DeviceGroupAssignment,
    DeviceTreeCounts,
    DevicesSummary,
    DeviceUpdate,
    MaintenanceEnterRequest,
    RustDeskHealth,
    RustDeskIdVerifyRequest,
    RustDeskIdVerifyResponse,
    RustDeskManualOverrideRequest,
)
from app.schemas.device_inventory import DeviceInventoryResponse, PatchStatusSnapshot
from app.schemas.device_note import DeviceNoteCreate, DeviceNoteResponse, DeviceNoteUpdate
from app.schemas.telemetry import DeviceHealth, DeviceHealthSummary, TelemetrySnapshot
from app.services.audit_service import AuditAction, audit_log
from app.services.permission_service import MAINTENANCE_MODE
from app.services.device_activity_service import DeviceActivityService
from app.services.device_inventory_service import DeviceInventoryService
from app.services.device_note_service import DeviceNoteService
from app.services.device_service import DeviceService
from app.services.device_summary_service import DeviceSummaryService
from app.services.device_telemetry_service import DeviceTelemetryService
from app.services.device_offline_analysis_service import analyze_device
from app.services.rustdesk_service import RustDeskIdentityService

router = APIRouter(dependencies=[Depends(get_current_operator)])


# ------------------------------------------------------------------ #
# Shared scope helper                                                  #
# ------------------------------------------------------------------ #

def get_scoped_device(
    device_id: int,
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
) -> Device:
    """Dependency: fetch a device and gate by operator scope.

    Returns 404 (not 403) when the device is out of scope so callers
    cannot enumerate device IDs through the error code.
    """
    device = DeviceService(db).get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if not device_in_scope(device.client_id, device.group_id, device.id, scope):
        raise HTTPException(status_code=404, detail="Device not found")
    return device


# ------------------------------------------------------------------ #
# List / count / bulk                                                  #
# ------------------------------------------------------------------ #

@router.get("/", response_model=List[DeviceSchema])
def read_devices(
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    skip: int = 0,
    limit: int = Query(default=100, le=1000),
    status: Optional[DeviceStatus] = None,
    device_type: Optional[DeviceType] = None,
    freshness_state: Optional[DeviceFreshnessState] = None,
    client_id: Optional[int] = None,
    group_id: Optional[int] = None,
    assignment_source: Optional[str] = None,
    lifecycle_state: Optional[str] = "active",
    search: Optional[str] = None,
    duplicate_candidates: Optional[bool] = None,
    maintenance_state: Optional[str] = None,
    smart_folder: Optional[str] = None,
):
    return DeviceService(db).get_devices(
        skip=skip,
        limit=limit,
        status=status,
        device_type=device_type,
        freshness_state=freshness_state,
        client_id=client_id,
        group_id=group_id,
        assignment_source=assignment_source,
        lifecycle_state=lifecycle_state,
        search=search,
        duplicate_candidates=duplicate_candidates,
        maintenance_state=maintenance_state,
        smart_folder=smart_folder,
        scope=scope,
    )


@router.get("/stats")
def read_devices_stats(
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    return DeviceService(db).get_devices_stats(scope=scope)


@router.get("/tree", response_model=DeviceTreeCounts)
def read_device_tree(
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Lightweight GROUP BY aggregation — returns device counts per client only.
    Used by the Device Tree sidebar to render immediately before the full summary loads."""
    return DeviceRepository(db).count_by_client(scope=scope)


@router.get("/summary", response_model=DevicesSummary)
def read_devices_summary(
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    return DeviceSummaryService(db).get_summary(scope=scope)


@router.get("/count")
def read_devices_count(
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    status: Optional[DeviceStatus] = None,
    device_type: Optional[DeviceType] = None,
    freshness_state: Optional[DeviceFreshnessState] = None,
    client_id: Optional[int] = None,
    group_id: Optional[int] = None,
    assignment_source: Optional[str] = None,
    lifecycle_state: Optional[str] = "active",
    search: Optional[str] = None,
    duplicate_candidates: Optional[bool] = None,
    maintenance_state: Optional[str] = None,
    smart_folder: Optional[str] = None,
):
    count = DeviceService(db).get_devices_count(
        status=status,
        device_type=device_type,
        freshness_state=freshness_state,
        client_id=client_id,
        group_id=group_id,
        assignment_source=assignment_source,
        lifecycle_state=lifecycle_state,
        search=search,
        duplicate_candidates=duplicate_candidates,
        maintenance_state=maintenance_state,
        smart_folder=smart_folder,
        scope=scope,
    )
    return {"count": count}


@router.get("/health", response_model=List[DeviceHealthSummary])
def read_devices_health_summary(
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    devices = DeviceService(db).get_devices(limit=1000, scope=scope)
    return DeviceTelemetryService(db).get_health_summary_all(devices)


@router.get("/patch-status", response_model=List[PatchStatusSnapshot])
def read_devices_patch_status(
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    devices = DeviceService(db).get_devices(limit=1000, scope=scope)
    return DeviceInventoryService(db).get_patch_status_many([d.id for d in devices])


# ------------------------------------------------------------------ #
# Create / verify                                                      #
# ------------------------------------------------------------------ #

@router.post("/", response_model=DeviceSchema)
def create_device(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
    device_in: DeviceCreate,
):
    try:
        return DeviceService(db).create_device(device_in)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/rustdesk/verify", response_model=RustDeskIdVerifyResponse)
def verify_rustdesk_id(payload: RustDeskIdVerifyRequest, db: Session = Depends(get_db)):
    return RustDeskIdentityService(db).verify(payload.rustdesk_id)


# ------------------------------------------------------------------ #
# Single device — all use get_scoped_device                           #
# ------------------------------------------------------------------ #

@router.get("/{device_id}", response_model=DeviceSchema)
def read_device(device: Device = Depends(get_scoped_device)):
    return device


@router.get("/{device_id}/activity", response_model=List[ActivityEvent])
def read_device_activity(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
    limit: int = Query(default=40, le=100),
):
    return DeviceActivityService(db).get_activity_feed(device.id, limit=limit)


@router.get("/{device_id}/notes", response_model=List[DeviceNoteResponse])
def read_device_notes(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
    limit: int = Query(default=50, le=100),
):
    return DeviceNoteService(db).get_notes(device.id, limit=limit)


@router.post("/{device_id}/notes", response_model=DeviceNoteResponse)
def create_device_note(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
    payload: DeviceNoteCreate,
):
    note = payload.note.strip()
    if not note:
        raise HTTPException(status_code=400, detail="Note cannot be empty")
    created = DeviceNoteService(db).create_note(device.id, note, created_by=operator.username)
    audit_log(db, operator=operator, action=AuditAction.NOTE_CREATED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname, "note_id": created.id})
    return created


@router.put("/{device_id}/notes/{note_id}", response_model=DeviceNoteResponse)
def update_device_note(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
    note_id: int,
    payload: DeviceNoteUpdate,
):
    note = payload.note.strip()
    if not note:
        raise HTTPException(status_code=400, detail="Note cannot be empty")
    updated = DeviceNoteService(db).update_note(note_id, note, device_id=device.id)
    if not updated:
        raise HTTPException(status_code=404, detail="Note not found")
    audit_log(db, operator=operator, action=AuditAction.NOTE_UPDATED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname, "note_id": note_id})
    return updated


@router.delete("/{device_id}/notes/{note_id}", response_model=DeviceNoteResponse)
def delete_device_note(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
    note_id: int,
):
    deleted = DeviceNoteService(db).delete_note(note_id, device_id=device.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Note not found")
    audit_log(db, operator=operator, action=AuditAction.NOTE_DELETED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname, "note_id": note_id})
    return deleted


@router.get("/{device_id}/telemetry/latest", response_model=Optional[TelemetrySnapshot])
def read_device_telemetry_latest(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
):
    return DeviceTelemetryService(db).get_latest(device.id)


@router.get("/{device_id}/telemetry", response_model=List[TelemetrySnapshot])
def read_device_telemetry_history(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
    limit: int = Query(default=20, le=100),
):
    return DeviceTelemetryService(db).get_history(device.id, limit=limit)


@router.get("/{device_id}/health", response_model=DeviceHealth)
def read_device_health(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
):
    return DeviceTelemetryService(db).get_health(device)


@router.get("/{device_id}/rustdesk/health", response_model=RustDeskHealth)
def read_device_rustdesk_health(device: Device = Depends(get_scoped_device)):
    return RustDeskIdentityService.health(device)


@router.post("/{device_id}/rustdesk/verify", response_model=RustDeskIdVerifyResponse)
def verify_device_rustdesk_id(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
    payload: RustDeskIdVerifyRequest,
):
    return RustDeskIdentityService(db).verify(payload.rustdesk_id, exclude_device_id=device.id)


@router.put("/{device_id}/rustdesk", response_model=DeviceSchema)
def update_device_rustdesk_override(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_min_role(OperatorRole.ADMIN.value)),
    device: Device = Depends(get_scoped_device),
    payload: RustDeskManualOverrideRequest,
):
    try:
        return RustDeskIdentityService(db).manual_override(device, payload.rustdesk_id, reason=payload.reason)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{device_id}/assign-client", response_model=DeviceSchema)
def assign_device_client(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
    payload: DeviceClientAssignment,
):
    try:
        updated = DeviceService(db).assign_client(device.id, payload.client_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found")
    return updated


@router.put("/{device_id}/assign-group", response_model=DeviceSchema)
def assign_device_group(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
    payload: DeviceGroupAssignment,
):
    try:
        updated = DeviceService(db).assign_group(device.id, payload.group_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found")
    return updated


@router.put("/{device_id}/archive", response_model=DeviceSchema)
def archive_device(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
):
    updated = DeviceService(db).archive_device(device.id, archived_by=operator.username)
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found")
    audit_log(db, operator=operator, action=AuditAction.DEVICE_ARCHIVED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname})
    return updated


@router.put("/{device_id}/restore", response_model=DeviceSchema)
def restore_device(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    device: Device = Depends(get_scoped_device),
):
    updated = DeviceService(db).restore_device(device.id)
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found")
    audit_log(db, operator=operator, action=AuditAction.DEVICE_RESTORED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname})
    return updated


@router.put("/{device_id}/maintenance", response_model=DeviceSchema)
def enter_device_maintenance(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    _perm: None = Depends(require_team_permission(MAINTENANCE_MODE)),
    device: Device = Depends(get_scoped_device),
    payload: MaintenanceEnterRequest,
):
    if not payload.started_by:
        payload.started_by = operator.username
    updated = DeviceService(db).enter_maintenance(device.id, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found")
    audit_log(db, operator=operator, action=AuditAction.MAINTENANCE_ENTERED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname, "note": payload.note})
    return updated


@router.put("/{device_id}/maintenance/clear", response_model=DeviceSchema)
def clear_device_maintenance(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    _perm: None = Depends(require_team_permission(MAINTENANCE_MODE)),
    device: Device = Depends(get_scoped_device),
):
    updated = DeviceService(db).clear_maintenance(device.id)
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found")
    audit_log(db, operator=operator, action=AuditAction.MAINTENANCE_CLEARED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname})
    return updated


@router.put("/{device_id}", response_model=DeviceSchema)
def update_device(
    *,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
    device: Device = Depends(get_scoped_device),
    device_in: DeviceUpdate,
):
    try:
        updated = DeviceService(db).update_device(device.id, device_in)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found")
    return updated


@router.delete("/{device_id}", response_model=DeviceSchema)
def delete_device(
    *,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_roles(OperatorRole.ADMIN.value)),
    device: Device = Depends(get_scoped_device),
    confirm_delete: bool = Query(default=False),
):
    if not confirm_delete:
        raise HTTPException(status_code=400, detail="Permanent device delete requires explicit confirmation")
    deleted = DeviceService(db).delete_device(device.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Device not found")
    audit_log(db, operator=operator, action=AuditAction.DEVICE_DELETED, entity_type="device", entity_id=device.id, details={"hostname": device.hostname})
    return deleted


@router.get("/{device_id}/inventory", response_model=DeviceInventoryResponse)
def get_device_inventory(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
):
    return DeviceInventoryService(db).get_inventory(device.id)


@router.get("/{device_id}/offline-analysis")
def get_device_offline_analysis(
    *,
    db: Session = Depends(get_db),
    device: Device = Depends(get_scoped_device),
):
    """Return a dynamic offline analysis for the device.

    Loads peer devices from the same client to enable site-outage detection.
    No DB writes — purely computed from existing data.
    """
    peer_devices: List[Device] = []
    if device.client_id:
        peer_devices = (
            db.query(Device)
            .filter(Device.client_id == device.client_id, Device.is_archived.is_(False))
            .all()
        )
    elif device.public_ip:
        # Fallback: devices sharing the same public IP (cross-client LAN)
        peer_devices = (
            db.query(Device)
            .filter(Device.public_ip == device.public_ip, Device.is_archived.is_(False))
            .all()
        )
    return analyze_device(device, peer_devices).as_dict()
