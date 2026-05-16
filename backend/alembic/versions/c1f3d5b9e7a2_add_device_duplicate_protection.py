"""add device duplicate protection

Revision ID: c1f3d5b9e7a2
Revises: a7c3d9e2f401
Create Date: 2026-05-12 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "c1f3d5b9e7a2"
down_revision = "a7c3d9e2f401"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.add_column(sa.Column("duplicate_candidate", sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column("duplicate_of_device_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("duplicate_score", sa.Float(), nullable=True))

    op.execute("UPDATE devices SET duplicate_candidate = 0 WHERE duplicate_candidate IS NULL")

    with op.batch_alter_table("devices") as batch_op:
        batch_op.alter_column("duplicate_candidate", existing_type=sa.Boolean(), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.drop_column("duplicate_score")
        batch_op.drop_column("duplicate_of_device_id")
        batch_op.drop_column("duplicate_candidate")
