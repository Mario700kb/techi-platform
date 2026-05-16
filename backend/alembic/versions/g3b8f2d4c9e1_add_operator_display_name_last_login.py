"""add operator display_name and last_login_at

Revision ID: g3b8f2d4c9e1
Revises: 2a8c9d7e1f62
Create Date: 2026-05-13 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "g3b8f2d4c9e1"
down_revision: Union[str, None] = "2a8c9d7e1f62"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("operators", sa.Column("display_name", sa.String(length=255), nullable=True))
    op.add_column("operators", sa.Column("last_login_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("operators", "last_login_at")
    op.drop_column("operators", "display_name")
