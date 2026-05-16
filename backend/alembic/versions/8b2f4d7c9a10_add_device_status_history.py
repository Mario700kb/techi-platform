"""add device status history

Revision ID: 8b2f4d7c9a10
Revises: 3f9a1b2c4d5e
Create Date: 2026-05-10 22:10:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "8b2f4d7c9a10"
down_revision = "3f9a1b2c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_status_history",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("previous_status", sa.Enum("online", "offline", name="devicestatus"), nullable=True),
        sa.Column("new_status", sa.Enum("online", "offline", name="devicestatus"), nullable=False),
        sa.Column("reason", sa.String(length=160), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_device_status_history_id"), "device_status_history", ["id"], unique=False)
    op.create_index(
        op.f("ix_device_status_history_device_id"),
        "device_status_history",
        ["device_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_device_status_history_created_at"),
        "device_status_history",
        ["created_at"],
        unique=False,
    )
    op.create_index("ix_devices_status_last_seen", "devices", ["status", "last_seen"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_devices_status_last_seen", table_name="devices")
    op.drop_index(op.f("ix_device_status_history_created_at"), table_name="device_status_history")
    op.drop_index(op.f("ix_device_status_history_device_id"), table_name="device_status_history")
    op.drop_index(op.f("ix_device_status_history_id"), table_name="device_status_history")
    op.drop_table("device_status_history")
