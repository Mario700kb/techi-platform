import threading
import time
from typing import TYPE_CHECKING, List, Optional
from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from app.core.scope import AllowedScope

from app.models.device import Device, DeviceFreshnessState, DeviceStatus, DeviceType
from app.repositories.client_repository import ClientRepository
from app.repositories.device_group_repository import DeviceGroupRepository
from app.repositories.device_repository import DeviceRepository
from app.schemas.device import DeviceCreate, DeviceUpdate, MaintenanceEnterRequest
from app.services.device_activity_event_service import DeviceActivityEventService
from app.services.device_assignment_service import DeviceAssignmentService
from app.services.device_maintenance_service import DeviceMaintenanceService
from app.services.agent_package_service import AgentPackageService
from app.services.rustdesk_service import RustDeskIdentityService
from app.websocket.events import RealtimeEventType, build_event, device_payload
from app.websocket.publisher import realtime_publisher


_stats_cache: dict = {}
_stats_cache_lock = threading.Lock()
_STATS_TTL = 30.0


class DeviceService:
    def __init__(self, db: Session):
        self.repository = DeviceRepository(db)
        self.clients = ClientRepository(db)
        self.groups = DeviceGroupRepository(db)
        self.maintenance = DeviceMaintenanceService(db)
        self.activity = DeviceActivityEventService(db)
        self.assignment = DeviceAssignmentService(db)

    def get_device(self, device_id: int) -> Optional[Device]:
        device = self.repository.get(device_id)
        if device is not None:
            device = self.maintenance.expire_if_needed(device)
            device = self.assignment.apply_resolution(device)
        return device

    def get_device_by_rustdesk_id(self, rustdesk_id: str) -> Optional[Device]:
        return self.repository.get_by_rustdesk_id(rustdesk_id)

    def get_devices(
        self,
        skip: int = 0,
        limit: int = 100,
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
        agent_update_state: Optional[str] = None,
        scope: Optional["AllowedScope"] = None,
    ) -> List[Device]:
        active_agent_version = self._active_agent_version_for_filter(agent_update_state)
        devices = self.repository.get_multi(
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
            active_agent_version=active_agent_version,
            scope=scope,
        )
        return self.assignment.apply_resolution_many(devices)

    @staticmethod
    def _active_agent_version_for_filter(agent_update_state: Optional[str]) -> Optional[str]:
        if (agent_update_state or "").strip().lower() != "outdated":
            return None
        active_pkg = AgentPackageService().latest_active("windows-amd64")
        return active_pkg.version if active_pkg else None

    def create_device(self, device_in: DeviceCreate) -> Device:
        verification = RustDeskIdentityService(self.repository.db).verify(device_in.rustdesk_id)
        if not verification.valid:
            raise ValueError(verification.message or "Invalid TECHI Remote Support ID")
        # Check if rustdesk_id already exists
        existing = self.repository.get_by_rustdesk_id(device_in.rustdesk_id)
        if existing:
            raise ValueError(f"Device with rustdesk_id {device_in.rustdesk_id} already exists")

        return self.assignment.apply_resolution(self.repository.create(device_in))

    def update_device(self, device_id: int, device_in: DeviceUpdate) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        if device_in.rustdesk_id and device_in.rustdesk_id != device.rustdesk_id:
            verification = RustDeskIdentityService(self.repository.db).verify(device_in.rustdesk_id, exclude_device_id=device_id)
            if not verification.valid:
                raise ValueError(verification.message or "Invalid TECHI Remote Support ID")
        return self.assignment.apply_resolution(self.repository.update(device, device_in))

    def delete_device(self, device_id: int) -> Optional[Device]:
        return self.repository.hard_delete(device_id)

    def archive_device(self, device_id: int, archived_by: Optional[str] = None) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        archived = self.repository.archive(device, archived_by=archived_by)
        self.activity.record(
            device_id=archived.id,
            event_type="device_archived",
            summary="Device archived",
            actor=archived_by,
            fail_silently=True,
        )
        return self.assignment.apply_resolution(archived)

    def restore_device(self, device_id: int) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        restored = self.repository.restore(device)
        self.activity.record(
            device_id=restored.id,
            event_type="device_restored",
            summary="Device restored",
            fail_silently=True,
        )
        return self.assignment.apply_resolution(restored)

    def get_devices_count(
        self,
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
        agent_update_state: Optional[str] = None,
        scope: Optional["AllowedScope"] = None,
    ) -> int:
        active_agent_version = self._active_agent_version_for_filter(agent_update_state)
        return self.repository.count(
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
            active_agent_version=active_agent_version,
            scope=scope,
        )

    def get_devices_stats(self, scope: Optional["AllowedScope"] = None) -> dict:
        cache_key = scope  # AllowedScope is a frozen dataclass → hashable; None for admins
        with _stats_cache_lock:
            entry = _stats_cache.get(cache_key)
            if entry and (time.monotonic() - entry["ts"]) < _STATS_TTL:
                return entry["data"]
        data = self.repository.count_stats(scope=scope)
        with _stats_cache_lock:
            _stats_cache[cache_key] = {"data": data, "ts": time.monotonic()}
        return data

    def enter_maintenance(self, device_id: int, request: MaintenanceEnterRequest) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        updated = self.maintenance.enter_maintenance(
            device,
            duration_minutes=request.duration_minutes,
            note=request.note,
            started_by=request.started_by,
        )
        self.activity.record(
            device_id=updated.id,
            event_type="maintenance_entered",
            summary="Maintenance started",
            detail=request.note,
            actor=request.started_by,
            fail_silently=True,
        )
        return self.assignment.apply_resolution(updated)

    def clear_maintenance(self, device_id: int) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        updated = self.maintenance.clear_maintenance(device)
        self.activity.record(
            device_id=updated.id,
            event_type="maintenance_cleared",
            summary="Maintenance cleared",
            fail_silently=True,
        )
        return updated

    def assign_client(self, device_id: int, client_id: Optional[int]) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        if client_id is not None and not self.clients.get(client_id):
            raise ValueError("Client not found")
        old_client_id = device.client_id
        old_group_id = device.group_id
        group_id = device.group_id
        if client_id is None or (device.group and device.group.client_id != client_id):
            group_id = None
        updated = self.repository.update(
            device,
            DeviceUpdate(client_id=client_id, group_id=group_id, auto_assigned=False, assignment_source="manual"),
        )
        resolved = self.assignment.apply_resolution(updated)
        if old_client_id != resolved.client_id or old_group_id != resolved.group_id:
            self.activity.record(
                device_id=resolved.id,
                event_type="assignment_changed",
                summary="Assignment changed",
                detail=f"Client #{resolved.client_id or 'none'}, Group #{resolved.group_id or 'none'}",
                actor="admin",
                fail_silently=True,
            )
            realtime_publisher.publish_threadsafe(
                build_event(RealtimeEventType.DEVICE_UPDATED, data=device_payload(resolved), reason="assignment_changed"),
                dedupe_key=f"device_updated:{resolved.id}:assignment",
            )
        return resolved

    def assign_group(self, device_id: int, group_id: Optional[int]) -> Optional[Device]:
        device = self.repository.get(device_id)
        if not device:
            return None
        old_client_id = device.client_id
        old_group_id = device.group_id
        if group_id is None:
            updated = self.repository.update(
                device,
                DeviceUpdate(group_id=None, auto_assigned=False, assignment_source="manual"),
            )
            resolved = self.assignment.apply_resolution(updated)
            if old_group_id != resolved.group_id:
                self.activity.record(
                    device_id=resolved.id,
                    event_type="assignment_changed",
                    summary="Assignment changed",
                    detail=f"Client #{resolved.client_id or 'none'}, Group none",
                    actor="admin",
                    fail_silently=True,
                )
                realtime_publisher.publish_threadsafe(
                    build_event(RealtimeEventType.DEVICE_UPDATED, data=device_payload(resolved), reason="assignment_changed"),
                    dedupe_key=f"device_updated:{resolved.id}:assignment",
                )
            return resolved
        group = self.groups.get(group_id)
        if not group:
            raise ValueError("Group not found")
        updated = self.repository.update(
            device,
            DeviceUpdate(client_id=group.client_id, group_id=group.id, auto_assigned=False, assignment_source="manual"),
        )
        resolved = self.assignment.apply_resolution(updated)
        if old_client_id != resolved.client_id or old_group_id != resolved.group_id:
            self.activity.record(
                device_id=resolved.id,
                event_type="assignment_changed",
                summary="Assignment changed",
                detail=f"Client #{resolved.client_id or 'none'}, Group #{resolved.group_id or 'none'}",
                actor="admin",
                fail_silently=True,
            )
            realtime_publisher.publish_threadsafe(
                build_event(RealtimeEventType.DEVICE_UPDATED, data=device_payload(resolved), reason="assignment_changed"),
                dedupe_key=f"device_updated:{resolved.id}:assignment",
            )
        return resolved
