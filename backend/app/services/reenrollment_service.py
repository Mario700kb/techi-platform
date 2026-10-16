"""Admin decisions on re-enrollment requests.

When an enrollment matches a device that already belongs to another agent, the
device is not handed over (agent_enrollment_service._hold_for_review); the new
agent runs as its own device and a request is recorded. An admin then:

- approve: the device moves to the new agent (the reinstalled machine is the
  same device, keep its history), and the duplicate device created meanwhile
  is archived;
- reject: the request is closed and the new agent keeps running as its own
  device (two genuinely different machines);

Either way the real device keeps working until the decision is made.
"""
import logging

from sqlalchemy.orm import Session

from app.core.time import utcnow, utcnow_naive
from app.models.reenrollment_request import ReenrollmentRequest
from app.repositories.device_repository import DeviceRepository
from app.repositories.reenrollment_request_repository import ReenrollmentRequestRepository
from app.schemas.device import DeviceUpdate
from app.services.device_activity_event_service import DeviceActivityEventService

logger = logging.getLogger(__name__)


class ReenrollmentService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = ReenrollmentRequestRepository(db)
        self.devices = DeviceRepository(db)
        self.activity = DeviceActivityEventService(db)

    def approve(self, request_id: int, *, operator: str) -> ReenrollmentRequest:
        request = self._pending(request_id)
        device = self.devices.get(request.device_id)
        if device is None:
            raise ValueError("The device this request belongs to no longer exists")

        previous_agent_id = device.agent_id

        # The placeholder device created while the request waited is the same
        # machine. Free its agent_id (unique) and archive it before the victim
        # takes that id, so the fleet shows one device.
        if request.new_device_id and request.new_device_id != device.id:
            placeholder = self.devices.get(request.new_device_id)
            if placeholder is not None:
                if not placeholder.is_archived:
                    self.devices.archive(placeholder, archived_by=operator)
                self.devices.update(placeholder, DeviceUpdate(agent_id=None))

        self.devices.update(
            device,
            DeviceUpdate(
                agent_id=request.agent_id,
                reenrolled_from_agent_id=previous_agent_id,
                last_enrollment_at=utcnow(),
            ),
        )

        self.activity.record(
            device_id=device.id,
            event_type="reenrollment_approved",
            summary="Re-enrollment approved",
            detail=f"Device handed to agent {request.agent_id[:12]}… (was {(previous_agent_id or 'none')[:12]}…) by {operator}.",
            actor=operator,
            fail_silently=True,
        )
        self._close(request, decision="approved", operator=operator)
        return request

    def reject(self, request_id: int, *, operator: str) -> ReenrollmentRequest:
        request = self._pending(request_id)
        self.activity.record(
            device_id=request.device_id,
            event_type="reenrollment_rejected",
            summary="Re-enrollment rejected",
            detail=f"The agent that matched this device stays a separate device (#{request.new_device_id}). Decided by {operator}.",
            actor=operator,
            fail_silently=True,
        )
        self._close(request, decision="rejected", operator=operator)
        return request

    def _pending(self, request_id: int) -> ReenrollmentRequest:
        request = self.repo.get(request_id)
        if request is None:
            raise ValueError("Re-enrollment request not found")
        if request.status != "pending":
            raise ValueError("This re-enrollment request was already decided")
        return request

    def _close(self, request: ReenrollmentRequest, *, decision: str, operator: str) -> None:
        request.status = "decided"
        request.decision = decision
        request.decided_by = operator
        request.decided_at = utcnow_naive()
        self.db.add(request)
        self.db.commit()
