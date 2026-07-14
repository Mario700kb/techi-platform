"""track heartbeat trust transitions and authenticated Remote Support state

Revision ID: u5v6w7x8y9z0
Revises: t4u5v6w7x8y9
"""

from alembic import op
import sqlalchemy as sa


revision = "u5v6w7x8y9z0"
down_revision = "t4u5v6w7x8y9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("heartbeat_auth_state", sa.String(length=32), nullable=False, server_default="unknown"),
    )
    op.add_column("devices", sa.Column("heartbeat_auth_state_changed_at", sa.DateTime(), nullable=True))
    op.add_column(
        "devices",
        sa.Column("remote_support_trusted_state", sa.String(length=32), nullable=False, server_default="unknown"),
    )
    op.add_column("devices", sa.Column("remote_support_state_trusted_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("remote_support_state_reason", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "remote_support_state_reason")
    op.drop_column("devices", "remote_support_state_trusted_at")
    op.drop_column("devices", "remote_support_trusted_state")
    op.drop_column("devices", "heartbeat_auth_state_changed_at")
    op.drop_column("devices", "heartbeat_auth_state")
