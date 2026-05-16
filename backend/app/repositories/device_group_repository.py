from typing import List, Optional

from sqlalchemy.orm import Session
from sqlalchemy import func

from app.models.device_group import DeviceGroup
from app.schemas.device_group import DeviceGroupCreate, DeviceGroupUpdate


class DeviceGroupRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, group_id: int) -> Optional[DeviceGroup]:
        return self.db.query(DeviceGroup).filter(DeviceGroup.id == group_id).first()

    def get_by_client_and_name(self, client_id: int, name: str) -> Optional[DeviceGroup]:
        normalized = name.strip().lower()
        return (
            self.db.query(DeviceGroup)
            .filter(DeviceGroup.client_id == client_id)
            .filter(func.lower(func.trim(DeviceGroup.name)) == normalized)
            .first()
        )

    def get_duplicate_name(self, client_id: int, name: str, *, exclude_group_id: Optional[int] = None) -> Optional[DeviceGroup]:
        query = self.db.query(DeviceGroup).filter(DeviceGroup.client_id == client_id)
        query = query.filter(func.lower(func.trim(DeviceGroup.name)) == name.strip().lower())
        if exclude_group_id is not None:
            query = query.filter(DeviceGroup.id != exclude_group_id)
        return query.first()

    def list(self, *, client_id: Optional[int] = None) -> List[DeviceGroup]:
        query = self.db.query(DeviceGroup)
        if client_id is not None:
            query = query.filter(DeviceGroup.client_id == client_id)
        return query.order_by(DeviceGroup.name.asc()).all()

    def delete_by_client(self, client_id: int) -> int:
        count = self.db.query(DeviceGroup).filter(DeviceGroup.client_id == client_id).count()
        self.db.query(DeviceGroup).filter(DeviceGroup.client_id == client_id).delete(synchronize_session=False)
        self.db.commit()
        return count

    def create(self, payload: DeviceGroupCreate) -> DeviceGroup:
        group = DeviceGroup(
            name=payload.name.strip(),
            client_id=payload.client_id,
            description=payload.description,
        )
        self.db.add(group)
        self.db.commit()
        self.db.refresh(group)
        return group

    def update(self, group: DeviceGroup, payload: DeviceGroupUpdate) -> DeviceGroup:
        update_data = payload.model_dump(exclude_unset=True)
        if "name" in update_data and update_data["name"] is not None:
            update_data["name"] = update_data["name"].strip()
        for field, value in update_data.items():
            setattr(group, field, value)
        self.db.add(group)
        self.db.commit()
        self.db.refresh(group)
        return group

    def delete(self, group: DeviceGroup) -> DeviceGroup:
        self.db.delete(group)
        self.db.commit()
        return group
