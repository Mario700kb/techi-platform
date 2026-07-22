"""add agent_command_batches table and batch_id column to remote_actions

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
Create Date: 2026-06-16

"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "b3c4d5e6f7a8"
down_revision = "a2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    is_sqlite = op.get_bind().dialect.name == "sqlite"
    inspector = inspect(op.get_bind())
    if "agent_command_batches" not in inspector.get_table_names():
        op.create_table(
            "agent_command_batches",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("command_type", sa.String(64), nullable=False),
            sa.Column("payload", sa.Text, nullable=False, server_default="{}"),
            sa.Column("target", sa.String(32), nullable=False),
            sa.Column("timeout_seconds", sa.Integer, nullable=False, server_default="30"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "created_by",
                sa.Integer,
                sa.ForeignKey("operators.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )

    remote_action_columns = {column["name"] for column in inspector.get_columns("remote_actions")}
    if "batch_id" not in remote_action_columns:
        batch_column = sa.Column("batch_id", sa.String(36), nullable=True)
        if not is_sqlite:
            batch_column = sa.Column(
                "batch_id",
                sa.String(36),
                sa.ForeignKey("agent_command_batches.id", ondelete="SET NULL"),
                nullable=True,
            )
        op.add_column("remote_actions", batch_column)
    remote_action_indexes = {index["name"] for index in inspector.get_indexes("remote_actions")}
    if "ix_remote_actions_batch_id" not in remote_action_indexes:
        op.create_index("ix_remote_actions_batch_id", "remote_actions", ["batch_id"])


def downgrade() -> None:
    op.drop_index("ix_remote_actions_batch_id", table_name="remote_actions")
    op.drop_column("remote_actions", "batch_id")
    op.drop_table("agent_command_batches")
