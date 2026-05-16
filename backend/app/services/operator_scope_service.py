"""
OperatorScopeService — manages the scope assignments for operators and
resolves them into AllowedScope objects used for query filtering.
"""

import logging
from typing import List, Optional, Set

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.models.operator_scope import OperatorScope, ScopeType
from app.repositories.operator_scope_repository import OperatorScopeRepository

logger = logging.getLogger(__name__)


class OperatorScopeService:
    def __init__(self, db: Session):
        self.repo = OperatorScopeRepository(db)
        self.db = db

    # ------------------------------------------------------------------ #
    # Read                                                                 #
    # ------------------------------------------------------------------ #

    def get_allowed_scope(self, operator_id: int) -> AllowedScope:
        """Materialise all scope rows for an operator into an AllowedScope."""
        rows = self.repo.list_for_operator(operator_id)
        return AllowedScope(
            client_ids=frozenset(r.scope_id for r in rows if r.scope_type == ScopeType.CLIENT.value),
            group_ids=frozenset(r.scope_id for r in rows if r.scope_type == ScopeType.GROUP.value),
            device_ids=frozenset(r.scope_id for r in rows if r.scope_type == ScopeType.DEVICE.value),
        )

    def list_entries(self, operator_id: int) -> List[OperatorScope]:
        return self.repo.list_for_operator(operator_id)

    def get_visible_client_ids(self, scope: AllowedScope) -> Set[int]:
        """Return the set of client IDs visible under *scope*.

        Includes clients granted directly, clients whose groups are in scope,
        and clients that own any explicitly scoped device.
        """
        from app.models.device import Device
        from app.models.device_group import DeviceGroup

        visible: Set[int] = set(scope.client_ids)

        if scope.group_ids:
            rows = (
                self.db.query(DeviceGroup.client_id)
                .filter(DeviceGroup.id.in_(list(scope.group_ids)))
                .all()
            )
            visible.update(r[0] for r in rows if r[0] is not None)

        if scope.device_ids:
            rows = (
                self.db.query(Device.client_id)
                .filter(Device.id.in_(list(scope.device_ids)))
                .all()
            )
            visible.update(r[0] for r in rows if r[0] is not None)

        return visible

    def get_visible_group_ids(self, scope: AllowedScope) -> Set[int]:
        """Return the set of group IDs visible under *scope*."""
        from app.models.device import Device
        from app.models.device_group import DeviceGroup

        visible: Set[int] = set(scope.group_ids)

        if scope.client_ids:
            rows = (
                self.db.query(DeviceGroup.id)
                .filter(DeviceGroup.client_id.in_(list(scope.client_ids)))
                .all()
            )
            visible.update(r[0] for r in rows)

        if scope.device_ids:
            rows = (
                self.db.query(Device.group_id)
                .filter(Device.id.in_(list(scope.device_ids)))
                .all()
            )
            visible.update(r[0] for r in rows if r[0] is not None)

        return visible

    # ------------------------------------------------------------------ #
    # Write                                                                #
    # ------------------------------------------------------------------ #

    def add_entry(self, operator_id: int, scope_type: str, scope_id: int) -> OperatorScope:
        entry = self.repo.create(operator_id, scope_type, scope_id)
        logger.info("[scope] added %s/%d to operator #%d", scope_type, scope_id, operator_id)
        return entry

    def remove_entry(self, operator_id: int, entry_id: int) -> Optional[OperatorScope]:
        entry = self.repo.get(entry_id)
        if not entry or entry.operator_id != operator_id:
            return None
        logger.info("[scope] removed entry #%d (%s/%d) from operator #%d", entry_id, entry.scope_type, entry.scope_id, operator_id)
        return self.repo.delete(entry)

    def replace_scope(self, operator_id: int, entries: List[dict]) -> List[OperatorScope]:
        """Atomically replace all scope entries for an operator."""
        self.repo.clear_all(operator_id)
        result = []
        for e in entries:
            created = self.repo.create(operator_id, e["scope_type"], e["scope_id"])
            if created:
                result.append(created)
        return result
