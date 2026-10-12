"""Index for the offline-alert sweep's "alerted this episode?" check.

OfflineAlertSweep (every 30 s) asks, per offline device, whether an offline
alert was opened since the device's last contact. With only (device_id, kind,
state) to go on, PostgreSQL read every offline alert the device ever had —
~600 for a server that flapped before the new policy — taking 119 ms a pass
for seven devices. (device_id, kind, created_at) answers it with one seek.

Built CONCURRENTLY so heartbeat writes are never blocked; IF NOT EXISTS / IF
EXISTS so a re-run is harmless.

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
"""

from alembic import op

revision = "d4e5f6a7b8c9"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name != "postgresql":
        op.create_index("ix_device_alerts_device_kind_created", "device_alerts", ["device_id", "kind", "created_at"])
        return
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_alerts_device_kind_created "
            "ON device_alerts (device_id, kind, created_at)"
        )


def downgrade():
    if op.get_bind().dialect.name != "postgresql":
        op.drop_index("ix_device_alerts_device_kind_created", table_name="device_alerts")
        return
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_device_alerts_device_kind_created")
