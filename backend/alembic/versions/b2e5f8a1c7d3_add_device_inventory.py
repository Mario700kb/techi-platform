"""add device inventory

Revision ID: b2e5f8a1c7d3
Revises: f1a3c8e2b9d7
Create Date: 2026-05-12 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2e5f8a1c7d3"
down_revision: Union[str, None] = "f1a3c8e2b9d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "device_inventory",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column(
            "device_id",
            sa.Integer(),
            sa.ForeignKey("devices.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("processes_json", sa.Text(), nullable=True),
        sa.Column("services_json", sa.Text(), nullable=True),
        sa.Column("collected_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_device_inventory_device_id", "device_inventory", ["device_id"])


def downgrade() -> None:
    op.drop_index("ix_device_inventory_device_id", table_name="device_inventory")
    op.drop_table("device_inventory")
