"""add action timing columns

Revision ID: h1c2e4f6b9d3
Revises: g3b8f2d4c9e1
Create Date: 2026-05-13 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "h1c2e4f6b9d3"
down_revision: Union[str, None] = "g3b8f2d4c9e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    existing = {column["name"] for column in inspect(op.get_bind()).get_columns("remote_actions")}
    if "started_at" not in existing:
        op.add_column("remote_actions", sa.Column("started_at", sa.DateTime(), nullable=True))
    if "cancelled_at" not in existing:
        op.add_column("remote_actions", sa.Column("cancelled_at", sa.DateTime(), nullable=True))
    if "expired_at" not in existing:
        op.add_column("remote_actions", sa.Column("expired_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("remote_actions", "expired_at")
    op.drop_column("remote_actions", "cancelled_at")
    op.drop_column("remote_actions", "started_at")
