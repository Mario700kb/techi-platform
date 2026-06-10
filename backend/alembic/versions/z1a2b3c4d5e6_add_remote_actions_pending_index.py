"""add index on remote_actions(device_id, status) for queued action lookups

Revision ID: z1a2b3c4d5e6
Revises: y6z7a8b9c0d1
Create Date: 2026-06-10

"""
from alembic import op

revision = "z1a2b3c4d5e6"
down_revision = "y6z7a8b9c0d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Partial index covers get_pending_for_device() which filters status=QUEUED.
    # status is a PostgreSQL enum (actionstatus) so the literal requires a cast.
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_remote_actions_device_queued
        ON remote_actions (device_id, status)
        WHERE status = 'queued'::actionstatus
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_remote_actions_device_queued")
