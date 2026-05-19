"""add archived_checkin to alertkind enum

Revision ID: n5o6p7q8r9s0
Revises: m1n2o3p4q5r6
Create Date: 2026-05-20 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "n5o6p7q8r9s0"
down_revision: Union[str, None] = "m1n2o3p4q5r6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE alertkind ADD VALUE IF NOT EXISTS 'archived_checkin'")


def downgrade() -> None:
    # PostgreSQL does not support removing enum values; no-op downgrade.
    pass
