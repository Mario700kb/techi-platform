"""add remote actions

Revision ID: f1a3c8e2b9d7
Revises: d8f2a5c1e9b3
Create Date: 2026-05-12 01:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "f1a3c8e2b9d7"
down_revision = "d8f2a5c1e9b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_actions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("action_type", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "queued", "sent", "acknowledged", "running",
                "completed", "failed", "expired", "cancelled",
                name="actionstatus",
            ),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=True),
        sa.Column("queued_at", sa.DateTime(), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("failed_at", sa.DateTime(), nullable=True),
        sa.Column("result_message", sa.String(length=1024), nullable=True),
        sa.Column("error_message", sa.String(length=1024), nullable=True),
        sa.Column("execution_timeout_seconds", sa.Integer(), nullable=False, server_default="300"),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_remote_actions_id", "remote_actions", ["id"])
    op.create_index("ix_remote_actions_device_id", "remote_actions", ["device_id"])
    op.create_index("ix_remote_actions_status", "remote_actions", ["status"])


def downgrade() -> None:
    op.drop_index("ix_remote_actions_status", table_name="remote_actions")
    op.drop_index("ix_remote_actions_device_id", table_name="remote_actions")
    op.drop_index("ix_remote_actions_id", table_name="remote_actions")
    op.drop_table("remote_actions")
