"""add operator roles

Revision ID: 2a8c9d7e1f62
Revises: 6b9f2d1a4c8e
Create Date: 2026-05-13 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "2a8c9d7e1f62"
down_revision: Union[str, None] = "6b9f2d1a4c8e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("operators", sa.Column("role", sa.String(length=32), nullable=False, server_default="readonly"))
    op.create_index("ix_operators_role", "operators", ["role"])


def downgrade() -> None:
    op.drop_index("ix_operators_role", table_name="operators")
    op.drop_column("operators", "role")

