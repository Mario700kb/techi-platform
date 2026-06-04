"""add permissions column to teams table

Revision ID: v3w4x5y6z7a8
Revises: u2v3w4x5y6z7
Create Date: 2026-06-04 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "v3w4x5y6z7a8"
down_revision = "u2v3w4x5y6z7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing_cols = {col["name"] for col in sa.inspect(bind).get_columns("teams")}
    if "permissions" not in existing_cols:
        op.add_column("teams", sa.Column("permissions", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("teams", "permissions")
