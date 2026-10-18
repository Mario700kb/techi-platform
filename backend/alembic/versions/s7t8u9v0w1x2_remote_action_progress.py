"""Remote actions carry live progress

Revision ID: s7t8u9v0w1x2
Revises: r6s7t8u9v0w1
Create Date: 2026-10-18 16:00:00.000000

remote_actions.progress: overall percent 0–100 (null until reported).
remote_actions.stage: downloading | verifying | installing | restarting |
confirming (null until reported, and again once completed).
Both nullable, no default: existing rows stay as they are.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "s7t8u9v0w1x2"
down_revision: Union[str, None] = "r6s7t8u9v0w1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("remote_actions", sa.Column("progress", sa.SmallInteger(), nullable=True))
    op.add_column("remote_actions", sa.Column("stage", sa.String(length=24), nullable=True))


def downgrade() -> None:
    op.drop_column("remote_actions", "stage")
    op.drop_column("remote_actions", "progress")
