from typing import List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.team import Team, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember


class TeamRepository:
    def __init__(self, db: Session):
        self.db = db

    # ── Teams ──────────────────────────────────────────────────────────── #

    def list_all(self) -> List[Team]:
        return self.db.query(Team).order_by(Team.name).all()

    def get(self, team_id: int) -> Optional[Team]:
        return self.db.query(Team).filter(Team.id == team_id).first()

    def get_by_name(self, name: str) -> Optional[Team]:
        return self.db.query(Team).filter(Team.name == name).first()

    def create(self, name: str, description: Optional[str] = None, color: Optional[str] = None) -> Team:
        team = Team(name=name, description=description, color=color or "#f97316")
        self.db.add(team)
        self.db.commit()
        self.db.refresh(team)
        return team

    def update(self, team: Team, **kwargs) -> Team:
        for k, v in kwargs.items():
            if v is not None:
                setattr(team, k, v)
        self.db.commit()
        self.db.refresh(team)
        return team

    def delete(self, team: Team) -> None:
        self.db.delete(team)
        self.db.commit()

    # ── Members ────────────────────────────────────────────────────────── #

    def list_members(self, team_id: int) -> List[TeamMember]:
        return self.db.query(TeamMember).filter(TeamMember.team_id == team_id).all()

    def get_operator_ids(self, team_id: int) -> List[int]:
        rows = self.db.query(TeamMember.operator_id).filter(TeamMember.team_id == team_id).all()
        return [r[0] for r in rows]

    def add_member(self, team_id: int, operator_id: int) -> TeamMember:
        existing = self.db.query(TeamMember).filter_by(team_id=team_id, operator_id=operator_id).first()
        if existing:
            return existing
        m = TeamMember(team_id=team_id, operator_id=operator_id)
        self.db.add(m)
        try:
            self.db.commit()
            self.db.refresh(m)
        except IntegrityError:
            self.db.rollback()
            return self.db.query(TeamMember).filter_by(team_id=team_id, operator_id=operator_id).first()
        return m

    def remove_member(self, team_id: int, operator_id: int) -> bool:
        rows = self.db.query(TeamMember).filter_by(team_id=team_id, operator_id=operator_id).delete()
        self.db.commit()
        return rows > 0

    def get_team_ids_for_operator(self, operator_id: int) -> List[int]:
        rows = self.db.query(TeamMember.team_id).filter(TeamMember.operator_id == operator_id).all()
        return [r[0] for r in rows]

    # ── Client access ──────────────────────────────────────────────────── #

    def list_client_ids(self, team_id: int) -> List[int]:
        rows = self.db.query(TeamClientAccess.client_id).filter(TeamClientAccess.team_id == team_id).all()
        return [r[0] for r in rows]

    def replace_client_access(self, team_id: int, client_ids: List[int]) -> None:
        self.db.query(TeamClientAccess).filter_by(team_id=team_id).delete()
        for cid in set(client_ids):
            self.db.add(TeamClientAccess(team_id=team_id, client_id=cid))
        self.db.commit()

    # ── Group access ───────────────────────────────────────────────────── #

    def list_group_ids(self, team_id: int) -> List[int]:
        rows = self.db.query(TeamGroupAccess.group_id).filter(TeamGroupAccess.team_id == team_id).all()
        return [r[0] for r in rows]

    def replace_group_access(self, team_id: int, group_ids: List[int]) -> None:
        self.db.query(TeamGroupAccess).filter_by(team_id=team_id).delete()
        for gid in set(group_ids):
            self.db.add(TeamGroupAccess(team_id=team_id, group_id=gid))
        self.db.commit()

    # ── Device access ──────────────────────────────────────────────────── #

    def list_device_ids(self, team_id: int) -> List[int]:
        rows = self.db.query(TeamDeviceAccess.device_id).filter(TeamDeviceAccess.team_id == team_id).all()
        return [r[0] for r in rows]

    def replace_device_access(self, team_id: int, device_ids: List[int]) -> None:
        self.db.query(TeamDeviceAccess).filter_by(team_id=team_id).delete()
        for did in set(device_ids):
            self.db.add(TeamDeviceAccess(team_id=team_id, device_id=did))
        self.db.commit()
