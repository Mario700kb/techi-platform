from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.device_group import DeviceGroup
from app.repositories.client_repository import ClientRepository
from app.repositories.device_repository import DeviceRepository
from app.repositories.device_group_repository import DeviceGroupRepository
from app.schemas.device_group import (
    DeviceGroupCreate,
    DeviceGroupDuplicateCleanupRequest,
    DeviceGroupDuplicateCleanupResult,
    DeviceGroupUpdate,
)


class DeviceGroupService:
    def __init__(self, db: Session):
        self.clients = ClientRepository(db)
        self.devices = DeviceRepository(db)
        self.groups = DeviceGroupRepository(db)

    def list_groups(self, *, client_id: Optional[int] = None) -> List[DeviceGroup]:
        return self.groups.list(client_id=client_id)

    def create_group(self, payload: DeviceGroupCreate) -> DeviceGroup:
        if not self.clients.get(payload.client_id):
            raise ValueError("Client not found")
        if self.groups.get_duplicate_name(payload.client_id, payload.name):
            raise ValueError("Group name already exists for this client")
        return self.groups.create(payload)

    def update_group(self, group_id: int, payload: DeviceGroupUpdate) -> Optional[DeviceGroup]:
        group = self.groups.get(group_id)
        if not group:
            return None
        if payload.name and self.groups.get_duplicate_name(group.client_id, payload.name, exclude_group_id=group.id):
            raise ValueError("Group name already exists for this client")
        return self.groups.update(group, payload)

    def delete_group(self, group_id: int) -> Optional[DeviceGroup]:
        group = self.groups.get(group_id)
        if not group:
            return None
        self.devices.clear_group(group_id)
        return self.groups.delete(group)

    def cleanup_duplicate_groups(
        self,
        payload: DeviceGroupDuplicateCleanupRequest,
    ) -> DeviceGroupDuplicateCleanupResult:
        groups = self.groups.list(client_id=payload.client_id)
        duplicate_sets = self._find_duplicate_sets(groups)
        merge_target = self.groups.get(payload.merge_target_group_id) if payload.merge_target_group_id else None
        if payload.merge_target_group_id and not merge_target:
            raise ValueError("Merge target group not found")

        for duplicate_set in duplicate_sets:
            target = self._target_for_duplicate_set(duplicate_set, merge_target)
            for group in duplicate_set:
                if group.id == target.id:
                    continue
                device_count = self.devices.count_by_group(group.id)
                if device_count > 0 and not (merge_target and target.id == merge_target.id):
                    raise ValueError(
                        f'Duplicate group "{group.name}" has {device_count} device(s). Provide merge_target_group_id={target.id} to merge safely.'
                    )

        deleted_group_ids = []
        merged_group_ids = []
        moved_devices = 0
        for duplicate_set in duplicate_sets:
            target = self._target_for_duplicate_set(duplicate_set, merge_target)
            for group in duplicate_set:
                if group.id == target.id:
                    continue
                device_count = self.devices.count_by_group(group.id)
                if device_count > 0:
                    moved_devices += self.devices.move_group_devices(group.id, target.id)
                    merged_group_ids.append(group.id)
                else:
                    deleted_group_ids.append(group.id)
                self.groups.delete(group)

        return DeviceGroupDuplicateCleanupResult(
            deleted_group_ids=deleted_group_ids,
            merged_group_ids=merged_group_ids,
            detached_device_count=moved_devices,
            message="Duplicate group cleanup complete",
        )

    @staticmethod
    def _find_duplicate_sets(groups: List[DeviceGroup]) -> List[List[DeviceGroup]]:
        buckets = {}
        for group in groups:
            key = (group.client_id, group.name.strip().lower())
            buckets.setdefault(key, []).append(group)
        return [sorted(items, key=lambda group: group.id) for items in buckets.values() if len(items) > 1]

    @staticmethod
    def _target_for_duplicate_set(duplicate_set: List[DeviceGroup], merge_target: Optional[DeviceGroup]) -> DeviceGroup:
        if merge_target and any(group.id == merge_target.id for group in duplicate_set):
            return merge_target
        return duplicate_set[0]
