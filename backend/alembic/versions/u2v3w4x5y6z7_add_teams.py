"""add teams, team_members, team_*_access tables + default All-Devices team

Revision ID: u2v3w4x5y6z7
Revises: t1u2v3w4x5y6
Create Date: 2026-06-04 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "u2v3w4x5y6z7"
down_revision = "t1u2v3w4x5y6"
branch_labels = None
depends_on = None


def _tables() -> set:
    return {t for t in sa.inspect(op.get_bind()).get_table_names()}


def upgrade() -> None:
    existing = _tables()

    if "teams" not in existing:
        op.create_table(
            "teams",
            sa.Column("id", sa.Integer, primary_key=True, index=True),
            sa.Column("name", sa.String(128), nullable=False, unique=True),
            sa.Column("description", sa.String(512), nullable=True),
            sa.Column("color", sa.String(16), nullable=True, default="#f97316"),
            sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        )

    if "team_members" not in existing:
        op.create_table(
            "team_members",
            sa.Column("id", sa.Integer, primary_key=True, index=True),
            sa.Column("team_id", sa.Integer, sa.ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("operator_id", sa.Integer, sa.ForeignKey("operators.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.UniqueConstraint("team_id", "operator_id", name="uq_team_member"),
        )

    if "team_client_access" not in existing:
        op.create_table(
            "team_client_access",
            sa.Column("id", sa.Integer, primary_key=True, index=True),
            sa.Column("team_id", sa.Integer, sa.ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
            sa.UniqueConstraint("team_id", "client_id", name="uq_team_client"),
        )

    if "team_group_access" not in existing:
        op.create_table(
            "team_group_access",
            sa.Column("id", sa.Integer, primary_key=True, index=True),
            sa.Column("team_id", sa.Integer, sa.ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("group_id", sa.Integer, sa.ForeignKey("device_groups.id", ondelete="CASCADE"), nullable=False),
            sa.UniqueConstraint("team_id", "group_id", name="uq_team_group"),
        )

    if "team_device_access" not in existing:
        op.create_table(
            "team_device_access",
            sa.Column("id", sa.Integer, primary_key=True, index=True),
            sa.Column("team_id", sa.Integer, sa.ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("device_id", sa.Integer, sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
            sa.UniqueConstraint("team_id", "device_id", name="uq_team_device"),
        )

    # Seed default "All Devices" team so no operator loses visibility
    bind = op.get_bind()
    team_exists = bind.execute(sa.text("SELECT id FROM teams WHERE name = 'All Devices' LIMIT 1")).fetchone()
    if not team_exists:
        bind.execute(sa.text(
            "INSERT INTO teams (name, description, color, created_at) "
            "VALUES ('All Devices', 'Default team — full fleet access', '#6366f1', CURRENT_TIMESTAMP)"
        ))
        team_row = bind.execute(sa.text("SELECT id FROM teams WHERE name = 'All Devices' LIMIT 1")).fetchone()
        if team_row:
            team_id = team_row[0]
            # Add every existing operator as a member
            operators = bind.execute(sa.text("SELECT id FROM operators")).fetchall()
            for (op_id,) in operators:
                exists = bind.execute(
                    sa.text("SELECT 1 FROM team_members WHERE team_id = :tid AND operator_id = :oid"),
                    {"tid": team_id, "oid": op_id},
                ).fetchone()
                if not exists:
                    bind.execute(
                        sa.text("INSERT INTO team_members (team_id, operator_id) VALUES (:tid, :oid)"),
                        {"tid": team_id, "oid": op_id},
                    )
            # Grant access to every existing client
            clients = bind.execute(sa.text("SELECT id FROM clients")).fetchall()
            for (cid,) in clients:
                exists = bind.execute(
                    sa.text("SELECT 1 FROM team_client_access WHERE team_id = :tid AND client_id = :cid"),
                    {"tid": team_id, "cid": cid},
                ).fetchone()
                if not exists:
                    bind.execute(
                        sa.text("INSERT INTO team_client_access (team_id, client_id) VALUES (:tid, :cid)"),
                        {"tid": team_id, "cid": cid},
                    )


def downgrade() -> None:
    for table in ["team_device_access", "team_group_access", "team_client_access", "team_members", "teams"]:
        op.drop_table(table)
