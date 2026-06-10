from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.device import Device
from app.models.enrollment_audit import EnrollmentAudit


SUCCESS_RESULTS = ("success", "duplicate", "updated_existing")
DUPLICATE_RESULTS = ("duplicate", "updated_existing")


class EnrollmentAuditRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, **values) -> EnrollmentAudit:
        event = EnrollmentAudit(**values)
        self.db.add(event)
        self.db.commit()
        self.db.refresh(event)
        return event

    def list_by_token(self, token_id: int, *, limit: int, offset: int = 0):
        return (
            self.db.query(EnrollmentAudit)
            .filter(EnrollmentAudit.token_id == token_id)
            .order_by(EnrollmentAudit.created_at.desc(), EnrollmentAudit.id.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

    def counts_by_token(self, token_id: int) -> dict:
        successful_events = (
            self.db.query(func.count(EnrollmentAudit.id))
            .filter(
                EnrollmentAudit.token_id == token_id,
                EnrollmentAudit.result.in_(SUCCESS_RESULTS),
            )
            .scalar()
            or 0
        )
        duplicate_enrollments = (
            self.db.query(func.count(EnrollmentAudit.id))
            .filter(
                EnrollmentAudit.token_id == token_id,
                EnrollmentAudit.result.in_(DUPLICATE_RESULTS),
            )
            .scalar()
            or 0
        )
        failed_events = (
            self.db.query(func.count(EnrollmentAudit.id))
            .filter(
                EnrollmentAudit.token_id == token_id,
                EnrollmentAudit.result == "failed",
            )
            .scalar()
            or 0
        )
        unique_devices = (
            self.db.query(func.count(func.distinct(EnrollmentAudit.device_id)))
            .filter(
                EnrollmentAudit.token_id == token_id,
                EnrollmentAudit.result.in_(SUCCESS_RESULTS),
                EnrollmentAudit.device_id.is_not(None),
            )
            .scalar()
            or 0
        )
        archived_devices = (
            self.db.query(func.count(func.distinct(EnrollmentAudit.device_id)))
            .join(Device, Device.id == EnrollmentAudit.device_id)
            .filter(
                EnrollmentAudit.token_id == token_id,
                EnrollmentAudit.result.in_(SUCCESS_RESULTS),
                Device.is_archived.is_(True),
            )
            .scalar()
            or 0
        )
        total_events = (
            self.db.query(func.count(EnrollmentAudit.id))
            .filter(EnrollmentAudit.token_id == token_id)
            .scalar()
            or 0
        )
        return {
            "total_events": total_events,
            "successful_events": successful_events,
            "duplicate_enrollments": duplicate_enrollments,
            "failed_events": failed_events,
            "unique_devices": unique_devices,
            "archived_devices": archived_devices,
        }
