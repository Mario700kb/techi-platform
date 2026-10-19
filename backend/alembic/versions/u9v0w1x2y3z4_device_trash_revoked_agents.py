"""Device trash and revoked agents

Revision ID: u9v0w1x2y3z4
Revises: t8u9v0w1x2y3

Deleting a device moves it to the trash (devices.deleted_at/by/reason) for
30 days instead of removing it at once. revoked_agents keeps the agents of
archived and trashed devices, whose heartbeats are refused so the device does
not come back while the agent is still installed. A new empty table and three
nullable columns: nothing is rewritten.
"""
import sqlalchemy as sa
from alembic import op

revision = "u9v0w1x2y3z4"
down_revision = "t8u9v0w1x2y3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "revoked_agents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("agent_id", sa.String(length=128), nullable=False, unique=True),
        sa.Column("device_id", sa.Integer(), nullable=True),
        sa.Column("hostname", sa.String(length=255), nullable=True),
        sa.Column("client_id", sa.Integer(), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_by", sa.String(length=128), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("last_attempt_ip", sa.String(length=64), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_revoked_agents_device_id", "revoked_agents", ["device_id"])
    op.add_column("devices", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("deleted_by", sa.String(length=128), nullable=True))
    op.add_column("devices", sa.Column("delete_reason", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "delete_reason")
    op.drop_column("devices", "deleted_by")
    op.drop_column("devices", "deleted_at")
    op.drop_index("ix_revoked_agents_device_id", table_name="revoked_agents")
    op.drop_table("revoked_agents")
