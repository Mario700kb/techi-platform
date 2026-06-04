from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint

from app.db.base import Base


class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), nullable=False, unique=True)
    description = Column(String(512), nullable=True)
    color = Column(String(16), nullable=True, default="#f97316")
    permissions = Column(Text, nullable=True)  # JSON-encoded list of permission strings; NULL = no team-level overrides
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TeamMember(Base):
    __tablename__ = "team_members"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id", ondelete="CASCADE"), nullable=False, index=True)

    __table_args__ = (UniqueConstraint("team_id", "operator_id", name="uq_team_member"),)


class TeamClientAccess(Base):
    __tablename__ = "team_client_access"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)

    __table_args__ = (UniqueConstraint("team_id", "client_id", name="uq_team_client"),)


class TeamGroupAccess(Base):
    __tablename__ = "team_group_access"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True)
    group_id = Column(Integer, ForeignKey("device_groups.id", ondelete="CASCADE"), nullable=False)

    __table_args__ = (UniqueConstraint("team_id", "group_id", name="uq_team_group"),)


class TeamDeviceAccess(Base):
    __tablename__ = "team_device_access"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)

    __table_args__ = (UniqueConstraint("team_id", "device_id", name="uq_team_device"),)
