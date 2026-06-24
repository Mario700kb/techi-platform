import json
import logging
import uuid
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.device import Device
from app.models.operator import Operator
from app.models.remote_action import ActionStatus, RemoteAction
from app.repositories.agent_command_repository import AgentCommandRepository
from app.repositories.device_repository import DeviceRepository
from app.repositories.remote_action_repository import RemoteActionRepository
from app.schemas.agent_command import (
    BatchCreateResponse,
    BatchProgressResponse,
    BatchSummary,
    BulkCommandCreate,
    BulkCommandTarget,
    DeviceCommandStatus,
)

logger = logging.getLogger(__name__)

# Maps remote_action status → agent command concept
_STATUS_MAP = {
    ActionStatus.QUEUED: "queued",
    ActionStatus.SENT: "delivered",
    ActionStatus.ACKNOWLEDGED: "delivered",
    ActionStatus.RUNNING: "executing",
    ActionStatus.COMPLETED: "completed",
    ActionStatus.FAILED: "failed",
    ActionStatus.EXPIRED: "timeout",
    ActionStatus.CANCELLED: "timeout",
}


class AgentCommandService:
    def __init__(self, db: Session):
        self.db = db
        self.batch_repo = AgentCommandRepository(db)
        self.action_repo = RemoteActionRepository(db)
        self.device_repo = DeviceRepository(db)

    def create_bulk(
        self,
        create_in: BulkCommandCreate,
        operator_id: Optional[int] = None,
        operator_username: Optional[str] = None,
    ) -> BatchCreateResponse:
        devices = self._resolve_devices(create_in)
        if not devices:
            raise ValueError("No active devices found for the specified target")

        batch_id = str(uuid.uuid4())
        payload_json = json.dumps(create_in.payload)

        batch = self.batch_repo.create_batch(
            batch_id=batch_id,
            command_type=create_in.command_type,
            payload_json=payload_json,
            target=create_in.target.value,
            timeout_seconds=create_in.timeout_seconds,
            created_by=operator_id,
        )

        now = utcnow()
        for device in devices:
            action = RemoteAction(
                device_id=device.id,
                action_type=create_in.command_type,
                payload=payload_json,
                status=ActionStatus.QUEUED,
                created_at=now,
                queued_at=now,
                created_by=operator_username,
                execution_timeout_seconds=create_in.timeout_seconds,
                batch_id=batch_id,
            )
            self.db.add(action)

        self.db.commit()
        logger.info(
            "[command_batch] created %s batch=%s devices=%d by=%s",
            create_in.command_type,
            batch_id,
            len(devices),
            operator_username,
        )

        return BatchCreateResponse(
            batch_id=batch_id,
            device_count=len(devices),
            created_at=batch.created_at,
        )

    def get_batch_progress(self, batch_id: str) -> Optional[BatchProgressResponse]:
        batch = self.batch_repo.get_batch(batch_id)
        if batch is None:
            return None

        actions = self.batch_repo.get_batch_actions(batch_id)
        # Lazy-expire timed-out actions
        for action in actions:
            self.action_repo._expire_if_needed(action)

        counts = {"queued": 0, "delivered": 0, "executing": 0, "completed": 0, "failed": 0, "timeout": 0}
        device_statuses: List[DeviceCommandStatus] = []

        for action in actions:
            concept = _STATUS_MAP.get(action.status, "queued")
            counts[concept] = counts.get(concept, 0) + 1

            device = self.device_repo.get(action.device_id)
            device_statuses.append(DeviceCommandStatus(
                device_id=action.device_id,
                hostname=device.hostname if device else None,
                status=concept,
                output=action.output or action.result_message,
                error=action.error_message or action.stderr_output,
            ))

        total = len(actions)
        done = counts["completed"] + counts["failed"] + counts["timeout"]
        percent = int(done / total * 100) if total > 0 else 0
        finished = total > 0 and done == total

        return BatchProgressResponse(
            batch_id=batch_id,
            command_type=batch.command_type,
            total=total,
            queued=counts["queued"],
            delivered=counts["delivered"],
            executing=counts["executing"],
            completed=counts["completed"],
            failed=counts["failed"],
            timeout=counts["timeout"],
            percent=percent,
            devices=device_statuses,
            created_at=batch.created_at,
            finished=finished,
        )

    def get_history(self, limit: int = 20, skip: int = 0) -> List[BatchSummary]:
        batches = self.batch_repo.get_history(limit=limit, skip=skip)
        result: List[BatchSummary] = []

        operator_ids = {batch.created_by for batch in batches if batch.created_by is not None}
        operator_names = {}
        if operator_ids:
            operators = self.db.query(Operator).filter(Operator.id.in_(operator_ids)).all()
            operator_names = {op.id: (op.display_name or op.username) for op in operators}

        for batch in batches:
            actions = self.batch_repo.get_batch_actions(batch.id)
            for action in actions:
                self.action_repo._expire_if_needed(action)

            counts = {"completed": 0, "failed": 0, "timeout": 0}
            for action in actions:
                concept = _STATUS_MAP.get(action.status, "queued")
                if concept in counts:
                    counts[concept] += 1

            total = len(actions)
            done = sum(counts.values())

            result.append(BatchSummary(
                batch_id=batch.id,
                command_type=batch.command_type,
                target=batch.target,
                total=total,
                completed=counts["completed"],
                failed=counts["failed"],
                timeout=counts["timeout"],
                finished=total > 0 and done == total,
                created_at=batch.created_at,
                created_by_name=operator_names.get(batch.created_by),
            ))

        return result

    def cancel_batch(self, batch_id: str) -> dict:
        batch = self.batch_repo.get_batch(batch_id)
        if batch is None:
            raise ValueError("Batch not found")

        actions = self.batch_repo.get_batch_actions(batch_id)
        cancelled = 0
        for action in actions:
            if action.status == ActionStatus.QUEUED:
                self.action_repo.mark_cancelled(action)
                cancelled += 1

        logger.info("[command_batch] cancelled batch=%s (cancelled=%d)", batch_id, cancelled)
        return {"cancelled": cancelled}

    def _resolve_devices(self, create_in: BulkCommandCreate) -> List[Device]:
        query = self.db.query(Device).filter(
            (Device.is_archived.is_(False)) | (Device.is_archived.is_(None))
        )

        if create_in.target == BulkCommandTarget.CLIENT:
            if not create_in.client_id:
                raise ValueError("client_id required for target=client")
            query = query.filter(Device.client_id == create_in.client_id)
        elif create_in.target == BulkCommandTarget.GROUP:
            if not create_in.group_id:
                raise ValueError("group_id required for target=group")
            query = query.filter(Device.group_id == create_in.group_id)
        elif create_in.target == BulkCommandTarget.DEVICES:
            if not create_in.device_ids:
                raise ValueError("device_ids required for target=devices")
            query = query.filter(Device.id.in_(create_in.device_ids))

        return query.all()
