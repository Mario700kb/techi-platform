"""add device assignment metadata

Revision ID: f61a5c7e2d90
Revises: e2c4b8d1f9a2
Create Date: 2026-05-12 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "f61a5c7e2d90"
down_revision = "e2c4b8d1f9a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.add_column(sa.Column("auto_assigned", sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column("assignment_source", sa.String(length=40), nullable=True))

    op.execute("UPDATE devices SET auto_assigned = 0 WHERE auto_assigned IS NULL")
    op.execute(
        """
        UPDATE devices
        SET assignment_source = CASE
            WHEN client_id IS NULL AND group_id IS NULL THEN 'system_auto'
            ELSE 'manual'
        END
        WHERE assignment_source IS NULL
        """
    )

    with op.batch_alter_table("devices") as batch_op:
        batch_op.alter_column("auto_assigned", existing_type=sa.Boolean(), nullable=False)
        batch_op.alter_column("assignment_source", existing_type=sa.String(length=40), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.drop_column("assignment_source")
        batch_op.drop_column("auto_assigned")
