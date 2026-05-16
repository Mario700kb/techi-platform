from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.device_note import DeviceNote


class DeviceNoteRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, note_id: int) -> Optional[DeviceNote]:
        return self.db.query(DeviceNote).filter(DeviceNote.id == note_id).first()

    def get_by_device(self, device_id: int, limit: int = 50) -> List[DeviceNote]:
        return (
            self.db.query(DeviceNote)
            .filter(DeviceNote.device_id == device_id)
            .order_by(DeviceNote.updated_at.desc(), DeviceNote.created_at.desc())
            .limit(limit)
            .all()
        )

    def create(self, device_id: int, note: str, created_by: Optional[str] = None) -> DeviceNote:
        now = datetime.utcnow()
        db_obj = DeviceNote(
            device_id=device_id,
            note=note,
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def update(self, db_obj: DeviceNote, note: str) -> DeviceNote:
        db_obj.note = note
        db_obj.updated_at = datetime.utcnow()
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def delete(self, db_obj: DeviceNote) -> DeviceNote:
        self.db.delete(db_obj)
        self.db.commit()
        return db_obj

