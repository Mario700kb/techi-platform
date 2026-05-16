"""add device maintenance mode

Revision ID: d8f2a5c1e9b3
Revises: c1f3d5b9e7a2
Create Date: 2026-05-12 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "d8f2a5c1e9b3"
down_revision = "c1f3d5b9e7a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.add_column(sa.Column("is_in_maintenance", sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column("maintenance_started_at", sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column("maintenance_ends_at", sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column("maintenance_note", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("maintenance_started_by", sa.String(length=128), nullable=True))

    op.execute("UPDATE devices SET is_in_maintenance = 0 WHERE is_in_maintenance IS NULL")

    with op.batch_alter_table("devices") as batch_op:
        batch_op.alter_column("is_in_maintenance", existing_type=sa.Boolean(), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.drop_column("maintenance_started_by")
        batch_op.drop_column("maintenance_note")
        batch_op.drop_column("maintenance_ends_at")
        batch_op.drop_column("maintenance_started_at")
        batch_op.drop_column("is_in_maintenance")
