"""add device archive lifecycle

Revision ID: a7c3d9e2f401
Revises: f61a5c7e2d90
Create Date: 2026-05-12 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "a7c3d9e2f401"
down_revision = "f61a5c7e2d90"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.add_column(sa.Column("is_archived", sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column("archived_at", sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column("archived_by", sa.String(length=128), nullable=True))

    op.execute("UPDATE devices SET is_archived = 0 WHERE is_archived IS NULL")

    with op.batch_alter_table("devices") as batch_op:
        batch_op.alter_column("is_archived", existing_type=sa.Boolean(), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.drop_column("archived_by")
        batch_op.drop_column("archived_at")
        batch_op.drop_column("is_archived")
