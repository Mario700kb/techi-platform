from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.reenrollment_request import ReenrollmentRequest


class ReenrollmentRequestRepository:
    """Queries only; the caller commits."""

    def __init__(self, db: Session):
        self.db = db

    def get(self, request_id: int) -> Optional[ReenrollmentRequest]:
        return self.db.query(ReenrollmentRequest).filter(ReenrollmentRequest.id == request_id).first()

    def for_device_agent(self, device_id: int, agent_id: str) -> Optional[ReenrollmentRequest]:
        return (
            self.db.query(ReenrollmentRequest)
            .filter(ReenrollmentRequest.device_id == device_id, ReenrollmentRequest.agent_id == agent_id)
            .first()
        )

    def pending_for_agent(self, device_id: int, agent_id: str) -> Optional[ReenrollmentRequest]:
        return (
            self.db.query(ReenrollmentRequest)
            .filter(
                ReenrollmentRequest.device_id == device_id,
                ReenrollmentRequest.agent_id == agent_id,
                ReenrollmentRequest.status == "pending",
            )
            .first()
        )

    def list(self, *, status: Optional[str] = None, device_id: Optional[int] = None, limit: int = 200) -> List[ReenrollmentRequest]:
        query = self.db.query(ReenrollmentRequest)
        if status:
            query = query.filter(ReenrollmentRequest.status == status)
        if device_id is not None:
            query = query.filter(ReenrollmentRequest.device_id == device_id)
        return query.order_by(ReenrollmentRequest.created_at.desc()).limit(limit).all()

    def add(self, request: ReenrollmentRequest) -> ReenrollmentRequest:
        self.db.add(request)
        self.db.flush()
        return request
