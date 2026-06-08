"""
TeamService — CRUD for teams, members, and device access.

TeamScopeService — resolves the combined AllowedScope for an operator
from all teams they belong to (used by get_operator_scope in auth.py).
"""

from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.models.team import Team
from app.models.team import TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember
from app.repositories.team_repository import TeamRepository, _decode_permissions


class TeamService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = TeamRepository(db)

    # ── Teams ──────────────────────────────────────────────────────────── #

    def list_teams(self) -> List[Team]:
        return self.repo.list_all()

    def list_teams_with_stats(self) -> List[Dict]:
        teams = self.repo.list_all()
        if not teams:
            return []

        operator_ids: Dict[int, List[int]] = {team.id: [] for team in teams}
        client_ids: Dict[int, set] = {team.id: set() for team in teams}
        group_ids: Dict[int, set] = {team.id: set() for team in teams}
        device_ids: Dict[int, set] = {team.id: set() for team in teams}

        for team_id, operator_id in self.db.query(TeamMember.team_id, TeamMember.operator_id).all():
            operator_ids[team_id].append(operator_id)
        for team_id, client_id in self.db.query(TeamClientAccess.team_id, TeamClientAccess.client_id).all():
            client_ids[team_id].add(client_id)
        for team_id, group_id in self.db.query(TeamGroupAccess.team_id, TeamGroupAccess.group_id).all():
            group_ids[team_id].add(group_id)
        for team_id, device_id in self.db.query(TeamDeviceAccess.team_id, TeamDeviceAccess.device_id).all():
            device_ids[team_id].add(device_id)

        client_teams: Dict[int, set] = {}
        group_teams: Dict[int, set] = {}
        device_teams: Dict[int, set] = {}
        for team in teams:
            for client_id in client_ids[team.id]:
                client_teams.setdefault(client_id, set()).add(team.id)
            for group_id in group_ids[team.id]:
                group_teams.setdefault(group_id, set()).add(team.id)
            for device_id in device_ids[team.id]:
                device_teams.setdefault(device_id, set()).add(team.id)

        from app.models.device import Device
        effective_ids: Dict[int, set] = {team.id: set() for team in teams}
        rows = (
            self.db.query(Device.id, Device.client_id, Device.group_id)
            .filter(Device.is_archived == False)  # noqa: E712
            .all()
        )
        for device_id, client_id, group_id in rows:
            matched = set(device_teams.get(device_id, ()))
            if client_id is not None:
                matched.update(client_teams.get(client_id, ()))
            if group_id is not None:
                matched.update(group_teams.get(group_id, ()))
            for team_id in matched:
                effective_ids[team_id].add(device_id)

        return [{
            "id": team.id,
            "name": team.name,
            "description": team.description,
            "color": team.color,
            "created_at": team.created_at,
            "permissions": _decode_permissions(team.permissions),
            "member_count": len(operator_ids[team.id]),
            "client_count": len(client_ids[team.id]),
            "group_count": len(group_ids[team.id]),
            "explicit_device_count": len(device_ids[team.id]),
            "effective_device_count": len(effective_ids[team.id]),
            "operator_ids": operator_ids[team.id],
        } for team in teams]

    def get_team(self, team_id: int) -> Optional[Team]:
        return self.repo.get(team_id)

    def create_team(
        self,
        name: str,
        description: Optional[str] = None,
        color: Optional[str] = None,
        permissions: Optional[List[str]] = None,
    ) -> Team:
        return self.repo.create(name=name, description=description, color=color, permissions=permissions)

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
        operator_ids = self.repo.get_operator_ids(team_id)
        client_ids = self.repo.list_client_ids(team_id)
        group_ids = self.repo.list_group_ids(team_id)
        device_ids = self.repo.list_device_ids(team_id)
        effective_device_count = 0
        filters = []
        from app.models.device import Device
        from sqlalchemy import or_
        if client_ids:
            filters.append(Device.client_id.in_(client_ids))
        if group_ids:
            filters.append(Device.group_id.in_(group_ids))
        if device_ids:
            filters.append(Device.id.in_(device_ids))
        if filters:
            effective_device_count = (
                self.db.query(Device)
                .filter(Device.is_archived == False)  # noqa: E712
                .filter(or_(*filters))
                .count()
            )
        return {
            "id": team.id,
            "name": team.name,
            "description": team.description,
            "color": team.color,
            "permissions": _decode_permissions(team.permissions),
            "created_at": team.created_at,
            "operator_ids": operator_ids,
            "client_ids": client_ids,
            "group_ids": group_ids,
            "device_ids": device_ids,
            "effective_device_count": effective_device_count,
        }

    # ── Stats ──────────────────────────────────────────────────────────── #

    def team_stats(self, team_id: int) -> Dict:
        """Return member, client, group, explicit device, and effective device counts for a team.

        effective_device_count = all non-archived devices reachable through
        selected clients, groups, or explicit device assignments (union).
        explicit_device_count  = only the directly assigned device IDs.
        """
        client_ids = self.repo.list_client_ids(team_id)
        group_ids = self.repo.list_group_ids(team_id)
        device_ids = self.repo.list_device_ids(team_id)

        from app.models.device import Device
        from sqlalchemy import or_
        effective_device_count = 0
        try:
            filters = []
            if client_ids:
                filters.append(Device.client_id.in_(client_ids))
            if group_ids:
                filters.append(Device.group_id.in_(group_ids))
            if device_ids:
                filters.append(Device.id.in_(device_ids))
            if filters:
                effective_device_count = (
                    self.db.query(Device)
                    .filter(Device.is_archived == False)  # noqa: E712
                    .filter(or_(*filters))
                    .count()
                )
        except Exception:
            pass

        return {
            "member_count": len(self.repo.get_operator_ids(team_id)),
            "client_count": len(client_ids),
            "group_count": len(group_ids),
            "explicit_device_count": len(device_ids),
            "effective_device_count": effective_device_count,
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
