"""add device software inventory

Revision ID: 4c6f8a2d1b90
Revises: b2e5f8a1c7d3
Create Date: 2026-05-12 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "4c6f8a2d1b90"
down_revision: Union[str, None] = "b2e5f8a1c7d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("device_inventory", sa.Column("software_json", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("device_inventory", "software_json")
