"""Indexes for the dashboard's 30-day trends.

- device_status_history (device_id, created_at): every trend query asks for
  each device's transitions around a point in time; without it the 1.27M-row
  table was read in full (2.5 s for the state-before query in production).
  Replaces ix_device_status_history_device_id, its prefix.
- device_alerts created_at and resolved_at: the alert trend selects alerts
  opened or resolved inside the window from ~1M rows.

Built CONCURRENTLY so heartbeat writes are never blocked while they build;
IF NOT EXISTS / IF EXISTS so a re-run is harmless.

Revision ID: c3d4e5f6a7b8
Revises: b1c2d3e4f5a6
"""

from alembic import op

revision = "c3d4e5f6a7b8"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name != "postgresql":
        op.create_index("ix_device_status_history_device_created", "device_status_history", ["device_id", "created_at"])
        op.create_index("ix_device_alerts_created_at", "device_alerts", ["created_at"])
        op.create_index("ix_device_alerts_resolved_at", "device_alerts", ["resolved_at"])
        op.drop_index("ix_device_status_history_device_id", table_name="device_status_history")
        return
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_status_history_device_created "
            "ON device_status_history (device_id, created_at)"
        )
        op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_alerts_created_at ON device_alerts (created_at)")
        op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_alerts_resolved_at ON device_alerts (resolved_at)")
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_device_status_history_device_id")


def downgrade():
    if op.get_bind().dialect.name != "postgresql":
        op.create_index("ix_device_status_history_device_id", "device_status_history", ["device_id"])
        op.drop_index("ix_device_alerts_resolved_at", table_name="device_alerts")
        op.drop_index("ix_device_alerts_created_at", table_name="device_alerts")
        op.drop_index("ix_device_status_history_device_created", table_name="device_status_history")
        return
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_status_history_device_id ON device_status_history (device_id)"
        )
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_device_alerts_resolved_at")
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_device_alerts_created_at")
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_device_status_history_device_created")
