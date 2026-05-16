"""add device patch inventory

Revision ID: 5e8a1c3f7b42
Revises: 4c6f8a2d1b90
Create Date: 2026-05-12 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "5e8a1c3f7b42"
down_revision: Union[str, None] = "4c6f8a2d1b90"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("device_inventory", sa.Column("patch_json", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("device_inventory", "patch_json")
