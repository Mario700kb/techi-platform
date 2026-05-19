"""add action output columns

Revision ID: m1n2o3p4q5r6
Revises: l5g6h7i8j9k0
Create Date: 2026-05-17 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "m1n2o3p4q5r6"
down_revision: Union[str, None] = "l5g6h7i8j9k0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    existing = {column["name"] for column in inspect(op.get_bind()).get_columns("remote_actions")}
    if "output" not in existing:
        op.add_column("remote_actions", sa.Column("output", sa.Text(), nullable=True))
    if "stderr_output" not in existing:
        op.add_column("remote_actions", sa.Column("stderr_output", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("remote_actions", "stderr_output")
    op.drop_column("remote_actions", "output")
