"""add composite index on device_telemetry(device_id, created_at DESC)

Eliminates the 800ms full-table seq scan (1.1M rows / 168MB) executed by
get_latest_for_device_ids() on every /api/v1/devices/summary call.
CONCURRENTLY avoids an exclusive table lock while heartbeats keep writing.

Revision ID: x5y6z7a8b9c0
Revises: w4x5y6z7a8b9
Create Date: 2026-06-09 00:00:00.000000
"""
from alembic import op
from sqlalchemy import text

revision = "x5y6z7a8b9c0"
down_revision = "w4x5y6z7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        op.create_index(
            "ix_device_telemetry_device_id_created_at",
            "device_telemetry",
            ["device_id", "created_at"],
            if_not_exists=True,
        )
        return

    # CONCURRENTLY must run outside any transaction block.
    # autocommit_block() is the Alembic-native way to achieve this.
    with op.get_context().autocommit_block():
        op.execute(text(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS "
            "ix_device_telemetry_device_id_created_at "
            "ON device_telemetry (device_id, created_at DESC)"
        ))


def downgrade() -> None:
    op.drop_index(
        "ix_device_telemetry_device_id_created_at",
        table_name="device_telemetry",
        if_exists=True,
    )
