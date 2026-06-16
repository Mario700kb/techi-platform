from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.agent_command_batch import AgentCommandBatch
from app.models.remote_action import RemoteAction


class AgentCommandRepository:
    def __init__(self, db: Session):
        self.db = db

    def create_batch(
        self,
        batch_id: str,
        command_type: str,
        payload_json: str,
        target: str,
        timeout_seconds: int,
        created_by: Optional[int],
    ) -> AgentCommandBatch:
        batch = AgentCommandBatch(
            id=batch_id,
            command_type=command_type,
            payload=payload_json,
            target=target,
            timeout_seconds=timeout_seconds,
            created_by=created_by,
        )
        self.db.add(batch)
        self.db.commit()
        self.db.refresh(batch)
        return batch

    def get_batch(self, batch_id: str) -> Optional[AgentCommandBatch]:
        return (
            self.db.query(AgentCommandBatch)
            .filter(AgentCommandBatch.id == batch_id)
            .first()
        )

    def get_batch_actions(self, batch_id: str) -> List[RemoteAction]:
        return (
            self.db.query(RemoteAction)
            .filter(RemoteAction.batch_id == batch_id)
            .order_by(RemoteAction.created_at.asc())
            .all()
        )

    def get_history(self, limit: int = 20, skip: int = 0) -> List[AgentCommandBatch]:
        return (
            self.db.query(AgentCommandBatch)
            .order_by(AgentCommandBatch.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
