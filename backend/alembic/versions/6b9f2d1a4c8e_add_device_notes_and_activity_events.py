"""add device notes and activity events

Revision ID: 6b9f2d1a4c8e
Revises: 5e8a1c3f7b42
Create Date: 2026-05-13 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "6b9f2d1a4c8e"
down_revision: Union[str, None] = "5e8a1c3f7b42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "device_notes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_device_notes_id", "device_notes", ["id"])
    op.create_index("ix_device_notes_device_id", "device_notes", ["device_id"])

    op.create_table(
        "device_activity_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("summary", sa.String(length=255), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("actor", sa.String(length=128), nullable=True),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_device_activity_events_id", "device_activity_events", ["id"])
    op.create_index("ix_device_activity_events_device_id", "device_activity_events", ["device_id"])
    op.create_index("ix_device_activity_events_event_type", "device_activity_events", ["event_type"])
    op.create_index("ix_device_activity_events_occurred_at", "device_activity_events", ["occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_device_activity_events_occurred_at", table_name="device_activity_events")
    op.drop_index("ix_device_activity_events_event_type", table_name="device_activity_events")
    op.drop_index("ix_device_activity_events_device_id", table_name="device_activity_events")
    op.drop_index("ix_device_activity_events_id", table_name="device_activity_events")
    op.drop_table("device_activity_events")
    op.drop_index("ix_device_notes_device_id", table_name="device_notes")
    op.drop_index("ix_device_notes_id", table_name="device_notes")
    op.drop_table("device_notes")

