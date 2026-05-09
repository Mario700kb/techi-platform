from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_

from app.models.device import Device, DeviceStatus, DeviceType
from app.schemas.device import DeviceCreate, DeviceUpdate


class DeviceRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, device_id: int) -> Optional[Device]:
        return self.db.query(Device).filter(Device.id == device_id).first()

    def get_by_rustdesk_id(self, rustdesk_id: str) -> Optional[Device]:
        return self.db.query(Device).filter(Device.rustdesk_id == rustdesk_id).first()

    def get_multi(
        self,
        skip: int = 0,
        limit: int = 100,
        status: Optional[DeviceStatus] = None,
        device_type: Optional[DeviceType] = None,
        client_id: Optional[int] = None,
        group_id: Optional[int] = None,
        search: Optional[str] = None,
    ) -> List[Device]:
        query = self.db.query(Device)

        if status:
            query = query.filter(Device.status == status)
        if device_type:
            query = query.filter(Device.device_type == device_type)
        if client_id:
            query = query.filter(Device.client_id == client_id)
        if group_id:
            query = query.filter(Device.group_id == group_id)
        if search:
            search_filter = or_(
                Device.hostname.ilike(f"%{search}%"),
                Device.rustdesk_id.ilike(f"%{search}%"),
                Device.current_user.ilike(f"%{search}%"),
                Device.public_ip.ilike(f"%{search}%"),
                Device.local_ip.ilike(f"%{search}%"),
            )
            query = query.filter(search_filter)

        return query.offset(skip).limit(limit).all()

    def create(self, obj_in: DeviceCreate) -> Device:
        db_obj = Device(**obj_in.dict())
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def update(self, db_obj: Device, obj_in: DeviceUpdate) -> Device:
        update_data = obj_in.dict(exclude_unset=True)
        for field, value in update_data.items():
            setattr(db_obj, field, value)
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def remove(self, device_id: int) -> Optional[Device]:
        obj = self.db.query(Device).get(device_id)
        if obj:
            self.db.delete(obj)
            self.db.commit()
        return obj

    def count(
        self,
        status: Optional[DeviceStatus] = None,
        device_type: Optional[DeviceType] = None,
        client_id: Optional[int] = None,
        group_id: Optional[int] = None,
        search: Optional[str] = None,
    ) -> int:
        query = self.db.query(Device)

        if status:
            query = query.filter(Device.status == status)
        if device_type:
            query = query.filter(Device.device_type == device_type)
        if client_id:
            query = query.filter(Device.client_id == client_id)
        if group_id:
            query = query.filter(Device.group_id == group_id)
        if search:
            search_filter = or_(
                Device.hostname.ilike(f"%{search}%"),
                Device.rustdesk_id.ilike(f"%{search}%"),
                Device.current_user.ilike(f"%{search}%"),
                Device.public_ip.ilike(f"%{search}%"),
                Device.local_ip.ilike(f"%{search}%"),
            )
            query = query.filter(search_filter)

        return query.count()
