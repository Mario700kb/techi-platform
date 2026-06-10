import logging
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm import sessionmaker

from app.models.device import Device
from app.models.enrollment_token import EnrollmentToken
from app.repositories.enrollment_audit_repository import EnrollmentAuditRepository
from app.schemas.agent import AgentEnrollmentRequest

logger = logging.getLogger(__name__)


class EnrollmentAuditService:
    def __init__(self, db: Session):
        self.db = db
        self.repository = EnrollmentAuditRepository(db)

    def record(
        self,
        *,
        payload: AgentEnrollmentRequest,
        result: str,
        token: Optional[EnrollmentToken] = None,
        device: Optional[Device] = None,
        reason: Optional[str] = None,
        raw_error: Optional[str] = None,
    ):
        audit_db = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=self.db.get_bind(),
            future=True,
        )()
        try:
            return EnrollmentAuditRepository(audit_db).create(
                token_id=token.id if token else None,
                token_name=token.name if token else None,
                token_prefix=token.token_prefix if token else None,
                client_id=token.client_id if token else None,
                group_id=token.group_id if token else None,
                device_id=device.id if device else None,
                hostname=self._clean(payload.hostname, 128),
                username=self._clean(payload.current_user, 128),
                domain=self._clean(payload.domain, 128),
                rustdesk_id=self._clean(payload.rustdesk_id, 64),
                public_ip=self._clean(payload.public_ip, 45),
                local_ip=self._clean(payload.local_ip, 45),
                result=result,
                reason=self._clean(reason, 255),
                raw_error=self._clean(raw_error, 500),
                fingerprint=self._fingerprint(payload),
                agent_id=self._clean(payload.agent_id, 80),
            )
        except Exception:
            audit_db.rollback()
            logger.exception("Failed to write enrollment audit event result=%s", result)
            return None
        finally:
            audit_db.close()

    def events(self, token_id: int, *, limit: int, offset: int = 0):
        return self.repository.list_by_token(token_id, limit=limit, offset=offset)

    def diagnostics(self, token: EnrollmentToken, *, event_limit: int = 20) -> dict:
        counts = self.repository.counts_by_token(token.id)
        events = self.events(token.id, limit=event_limit)
        uses = token.use_count or 0

        if counts["total_events"]:
            orphaned_uses = max(uses - counts["successful_events"], 0)
            inferred = counts["successful_events"] < uses
            note = (
                "Audit events do not cover every historical token use; orphaned uses are a conservative inference."
                if inferred
                else "Counts are based on enrollment audit events."
            )
            return {
                **counts,
                "orphaned_uses": orphaned_uses,
                "inferred": inferred,
                "inference_note": note,
                "last_events": events,
            }

        inferred = self._infer_legacy_counts(token)
        return {
            "total_events": 0,
            "successful_events": inferred["successful_events"],
            "duplicate_enrollments": inferred["duplicate_enrollments"],
            "failed_events": None,
            "unique_devices": inferred["unique_devices"],
            "archived_devices": inferred["archived_devices"],
            "orphaned_uses": inferred["orphaned_uses"],
            "inferred": True,
            "inference_note": inferred["inference_note"],
            "last_events": [],
        }

    def _infer_legacy_counts(self, token: EnrollmentToken) -> dict:
        if not token.client_id and not token.group_id:
            return {
                "successful_events": None,
                "duplicate_enrollments": None,
                "unique_devices": None,
                "archived_devices": None,
                "orphaned_uses": None,
                "inference_note": "No audit events exist and this legacy token has no client/group scope, so device attribution is unknown.",
            }

        query = self.db.query(Device).filter(Device.registered_at >= token.created_at)
        if token.client_id:
            query = query.filter(Device.client_id == token.client_id)
        if token.group_id:
            query = query.filter(Device.group_id == token.group_id)

        unique_devices = query.count()
        successful_events = (
            query.with_entities(func.coalesce(func.sum(Device.enrollment_count), 0)).scalar()
            or 0
        )
        archived_devices = query.filter(Device.is_archived.is_(True)).count()
        duplicate_enrollments = max(successful_events - unique_devices, 0)
        return {
            "successful_events": successful_events,
            "duplicate_enrollments": duplicate_enrollments,
            "unique_devices": unique_devices,
            "archived_devices": archived_devices,
            "orphaned_uses": max((token.use_count or 0) - successful_events, 0),
            "inference_note": "No audit events exist; counts are inferred from current devices matching the token client/group scope.",
        }

    @staticmethod
    def _clean(value: Optional[str], limit: int) -> Optional[str]:
        if value is None:
            return None
        cleaned = str(value).strip()
        return cleaned[:limit] or None

    @classmethod
    def _fingerprint(cls, payload: AgentEnrollmentRequest) -> Optional[str]:
        parts = [
            cls._clean(payload.hostname, 128),
            cls._clean(payload.domain, 128),
            cls._clean(payload.local_ip, 45),
            cls._clean(payload.public_ip, 45),
            cls._clean(payload.rustdesk_id, 64),
        ]
        fingerprint = "|".join(part or "" for part in parts).strip("|")
        return fingerprint[:255] or None
