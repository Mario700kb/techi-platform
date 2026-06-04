"""
TeamService — CRUD for teams, members, and device access.

TeamScopeService — resolves the combined AllowedScope for an operator
from all teams they belong to (used by get_operator_scope in auth.py).
"""

from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.models.team import Team
from app.repositories.team_repository import TeamRepository


class TeamService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = TeamRepository(db)

    # ── Teams ──────────────────────────────────────────────────────────── #

    def list_teams(self) -> List[Team]:
        return self.repo.list_all()

    def get_team(self, team_id: int) -> Optional[Team]:
        return self.repo.get(team_id)

    def create_team(self, name: str, description: Optional[str] = None, color: Optional[str] = None) -> Team:
        return self.repo.create(name=name, description=description, color=color)

    def update_team(self, team_id: int, **kwargs) -> Optional[Team]:
        team = self.repo.get(team_id)
        if not team:
            return None
        return self.repo.update(team, **kwargs)

    def delete_team(self, team_id: int) -> bool:
        team = self.repo.get(team_id)
        if not team:
            return False
        self.repo.delete(team)
        return True

    # ── Members ────────────────────────────────────────────────────────── #

    def add_member(self, team_id: int, operator_id: int) -> bool:
        team = self.repo.get(team_id)
        if not team:
            return False
        self.repo.add_member(team_id, operator_id)
        return True

    def remove_member(self, team_id: int, operator_id: int) -> bool:
        return self.repo.remove_member(team_id, operator_id)

    def replace_members(self, team_id: int, operator_ids: List[int]) -> None:
        from app.models.team import TeamMember
        self.db.query(TeamMember).filter_by(team_id=team_id).delete()
        for op_id in set(operator_ids):
            self.repo.add_member(team_id, op_id)

    # ── Access ─────────────────────────────────────────────────────────── #

    def replace_client_access(self, team_id: int, client_ids: List[int]) -> None:
        self.repo.replace_client_access(team_id, client_ids)

    def replace_group_access(self, team_id: int, group_ids: List[int]) -> None:
        self.repo.replace_group_access(team_id, group_ids)

    def replace_device_access(self, team_id: int, device_ids: List[int]) -> None:
        self.repo.replace_device_access(team_id, device_ids)

    def get_team_detail(self, team_id: int) -> Optional[Dict]:
        team = self.repo.get(team_id)
        if not team:
            return None
        return {
            "id": team.id,
            "name": team.name,
            "description": team.description,
            "color": team.color,
            "created_at": team.created_at,
            "operator_ids": self.repo.get_operator_ids(team_id),
            "client_ids": self.repo.list_client_ids(team_id),
            "group_ids": self.repo.list_group_ids(team_id),
            "device_ids": self.repo.list_device_ids(team_id),
        }

    # ── Stats ──────────────────────────────────────────────────────────── #

    def team_stats(self, team_id: int) -> Dict:
        """Return member count and approximate device count for a team."""
        client_ids = self.repo.list_client_ids(team_id)
        group_ids = self.repo.list_group_ids(team_id)
        device_ids = self.repo.list_device_ids(team_id)

        from app.models.device import Device
        from sqlalchemy import or_
        device_count = 0
        try:
            filters = []
            if client_ids:
                filters.append(Device.client_id.in_(client_ids))
            if group_ids:
                filters.append(Device.group_id.in_(group_ids))
            if device_ids:
                filters.append(Device.id.in_(device_ids))
            if filters:
                device_count = self.db.query(Device).filter(or_(*filters)).count()
        except Exception:
            pass

        return {
            "member_count": len(self.repo.get_operator_ids(team_id)),
            "device_count": device_count,
        }


class TeamScopeService:
    """Resolves the AllowedScope contributed by all teams an operator belongs to."""

    def __init__(self, db: Session):
        self.repo = TeamRepository(db)

    def get_team_scope_for_operator(self, operator_id: int) -> AllowedScope:
        team_ids = self.repo.get_team_ids_for_operator(operator_id)
        if not team_ids:
            return AllowedScope()

        client_ids: set = set()
        group_ids: set = set()
        device_ids: set = set()

        for tid in team_ids:
            client_ids.update(self.repo.list_client_ids(tid))
            group_ids.update(self.repo.list_group_ids(tid))
            device_ids.update(self.repo.list_device_ids(tid))

        return AllowedScope(
            client_ids=frozenset(client_ids),
            group_ids=frozenset(group_ids),
            device_ids=frozenset(device_ids),
        )
