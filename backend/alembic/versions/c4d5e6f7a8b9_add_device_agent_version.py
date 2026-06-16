"""add device agent_version column

Revision ID: c4d5e6f7a8b9
Revises: b3c4d5e6f7a8
Create Date: 2026-06-16

Stores the agent version string reported in each heartbeat payload.
Used by the backend to decide whether an agent_update should be sent
in the heartbeat response (Faza 2 self-update mechanism).
"""
from alembic import op
import sqlalchemy as sa

revision = "c4d5e6f7a8b9"
down_revision = "b3c4d5e6f7a8"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("devices", sa.Column("agent_version", sa.String(20), nullable=True))


def downgrade():
    op.drop_column("devices", "agent_version")
