from typing import List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.operator_scope import OperatorScope


class OperatorScopeRepository:
    def __init__(self, db: Session):
        self.db = db

    def list_for_operator(self, operator_id: int) -> List[OperatorScope]:
        return (
            self.db.query(OperatorScope)
            .filter(OperatorScope.operator_id == operator_id)
            .order_by(OperatorScope.scope_type, OperatorScope.scope_id)
            .all()
        )

    def get(self, entry_id: int) -> Optional[OperatorScope]:
        return self.db.query(OperatorScope).filter(OperatorScope.id == entry_id).first()

    def get_by_target(self, operator_id: int, scope_type: str, scope_id: int) -> Optional[OperatorScope]:
        return (
            self.db.query(OperatorScope)
            .filter_by(operator_id=operator_id, scope_type=scope_type, scope_id=scope_id)
            .first()
        )

    def create(self, operator_id: int, scope_type: str, scope_id: int) -> Optional[OperatorScope]:
        """Insert a new scope entry; return None if it already exists (idempotent)."""
        existing = self.get_by_target(operator_id, scope_type, scope_id)
        if existing:
            return existing
        entry = OperatorScope(operator_id=operator_id, scope_type=scope_type, scope_id=scope_id)
        self.db.add(entry)
        try:
            self.db.commit()
            self.db.refresh(entry)
        except IntegrityError:
            self.db.rollback()
            return self.get_by_target(operator_id, scope_type, scope_id)
        return entry

    def delete(self, entry: OperatorScope) -> OperatorScope:
        self.db.delete(entry)
        self.db.commit()
        return entry

    def clear_all(self, operator_id: int) -> int:
        count = self.db.query(OperatorScope).filter_by(operator_id=operator_id).count()
        self.db.query(OperatorScope).filter_by(operator_id=operator_id).delete()
        self.db.commit()
        return count
