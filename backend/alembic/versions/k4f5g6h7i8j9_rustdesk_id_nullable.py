"""rustdesk_id nullable — remove synthetic pending placeholders

Revision ID: k4f5g6h7i8j9
Revises: j3e4f5g6h7i8
Create Date: 2026-05-13
"""
from alembic import op
import sqlalchemy as sa

revision = "k4f5g6h7i8j9"
down_revision = "j3e4f5g6h7i8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.alter_column("rustdesk_id", existing_type=sa.String(64), nullable=True)

    with op.batch_alter_table("device_heartbeats") as batch_op:
        batch_op.alter_column("rustdesk_id", existing_type=sa.String(64), nullable=True)

    # NULL out all existing synthetic pending_ placeholders so the UI shows
    # "not resolved yet" instead of exposing internal IDs.
    op.execute(
        "UPDATE devices SET rustdesk_id = NULL "
        "WHERE rustdesk_id LIKE 'pending_%'"
    )
    op.execute(
        "UPDATE device_heartbeats SET rustdesk_id = NULL "
        "WHERE rustdesk_id LIKE 'pending_%'"
    )


def downgrade() -> None:
    # Restore a placeholder before reverting nullable constraint
    op.execute(
        "UPDATE devices SET rustdesk_id = 'unknown_' || CAST(id AS TEXT) "
        "WHERE rustdesk_id IS NULL"
    )
    op.execute(
        "UPDATE device_heartbeats SET rustdesk_id = 'unknown_' || CAST(id AS TEXT) "
        "WHERE rustdesk_id IS NULL"
    )

    with op.batch_alter_table("devices") as batch_op:
        batch_op.alter_column("rustdesk_id", existing_type=sa.String(64), nullable=False)

    with op.batch_alter_table("device_heartbeats") as batch_op:
        batch_op.alter_column("rustdesk_id", existing_type=sa.String(64), nullable=False)
