"""add index on remote_actions(device_id, status) for pending lookups

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
    # CONCURRENTLY not used: remote_actions has ~30 rows, lock is sub-millisecond.
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_remote_actions_device_pending
        ON remote_actions (device_id, status)
        WHERE status = 'pending'
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_remote_actions_device_pending")
