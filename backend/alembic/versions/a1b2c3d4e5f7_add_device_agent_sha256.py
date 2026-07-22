"""add device agent_sha256 column

Revision ID: a1b2c3d4e5f7
Revises: z1a2b3c4d5e6
Create Date: 2026-07-02

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "a1b2c3d4e5f7"
down_revision = "z1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in inspect(op.get_bind()).get_columns("devices")}
    if "agent_sha256" not in columns:
        op.add_column("devices", sa.Column("agent_sha256", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "agent_sha256")
