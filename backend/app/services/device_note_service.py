from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.device_note import DeviceNote
from app.repositories.device_note_repository import DeviceNoteRepository
from app.services.device_activity_event_service import DeviceActivityEventService


class DeviceNoteService:
    def __init__(self, db: Session):
        self.repository = DeviceNoteRepository(db)
        self.activity = DeviceActivityEventService(db)

    def get_notes(self, device_id: int, limit: int = 50) -> List[DeviceNote]:
        return self.repository.get_by_device(device_id, limit=limit)

    def create_note(self, device_id: int, note: str, created_by: Optional[str] = None) -> DeviceNote:
        cleaned = note.strip()
        if not cleaned:
            raise ValueError("Note cannot be empty")
        db_note = self.repository.create(device_id, cleaned, created_by=created_by)
        self.activity.record(
            device_id=device_id,
            event_type="note_added",
            summary="Note added",
            detail=self._preview(db_note.note),
            actor=db_note.created_by,
            fail_silently=True,
        )
        return db_note

    def update_note(self, note_id: int, note: str, device_id: Optional[int] = None) -> Optional[DeviceNote]:
        db_note = self.repository.get(note_id)
        if not db_note:
            return None
        if device_id is not None and db_note.device_id != device_id:
            return None
        cleaned = note.strip()
        if not cleaned:
            raise ValueError("Note cannot be empty")
        updated = self.repository.update(db_note, cleaned)
        self.activity.record(
            device_id=updated.device_id,
            event_type="note_edited",
            summary="Note edited",
            detail=self._preview(updated.note),
            actor=updated.created_by,
            fail_silently=True,
        )
        return updated

    def delete_note(self, note_id: int, device_id: Optional[int] = None) -> Optional[DeviceNote]:
        db_note = self.repository.get(note_id)
        if not db_note:
            return None
        if device_id is not None and db_note.device_id != device_id:
            return None
        device_id = db_note.device_id
        actor = db_note.created_by
        deleted = self.repository.delete(db_note)
        self.activity.record(
            device_id=device_id,
            event_type="note_deleted",
            summary="Note deleted",
            actor=actor,
            fail_silently=True,
        )
        return deleted

    def _preview(self, note: str) -> str:
        compact = " ".join(note.split())
        return compact[:160]
