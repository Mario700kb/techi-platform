"""add device_heartbeats.created_at index

The nightly cleanup job and heartbeat-history queries filter on created_at;
without this index every run full-scans the largest table in the system.

Production note (large table, live inserts): prefer building it without
blocking heartbeat INSERTs:

    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_heartbeats_created_at
        ON device_heartbeats (created_at);

then stamp this revision. The plain create below is fine for small tables
and SQLite dev.

Revision ID: b2c3d4e5f8a9
Revises: a1b2c3d4e5f7
Create Date: 2026-07-04

"""
from alembic import op

revision = "b2c3d4e5f8a9"
down_revision = "a1b2c3d4e5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_device_heartbeats_created_at",
        "device_heartbeats",
        ["created_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("ix_device_heartbeats_created_at", table_name="device_heartbeats")
