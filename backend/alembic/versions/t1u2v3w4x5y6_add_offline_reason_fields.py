"""add offline reason and future agent fields to devices

Revision ID: t1u2v3w4x5y6
Revises: s0t1u2v3w4x5
Create Date: 2026-06-04 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "t1u2v3w4x5y6"
down_revision = "s0t1u2v3w4x5"
branch_labels = None
depends_on = None


def _columns(table_name: str) -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table_name)}


def upgrade() -> None:
    existing = _columns("devices")
    new_cols = [
        ("offline_reason",          sa.Column("offline_reason",          sa.String(64),  nullable=True)),
        ("offline_confidence",      sa.Column("offline_confidence",      sa.String(16),  nullable=True)),
        ("last_boot_time",          sa.Column("last_boot_time",          sa.DateTime(),  nullable=True)),
        ("last_shutdown_time",      sa.Column("last_shutdown_time",      sa.DateTime(),  nullable=True)),
        ("network_disconnect_time", sa.Column("network_disconnect_time", sa.DateTime(),  nullable=True)),
    ]
    for col_name, col_def in new_cols:
        if col_name not in existing:
            op.add_column("devices", col_def)


def downgrade() -> None:
    for col_name in [
        "offline_reason",
        "offline_confidence",
        "last_boot_time",
        "last_shutdown_time",
        "network_disconnect_time",
    ]:
        op.drop_column("devices", col_name)
