"""add client slug and group description

Revision ID: e2c4b8d1f9a2
Revises: d4f7a9c2e1b0
Create Date: 2026-05-11 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "e2c4b8d1f9a2"
down_revision = "d4f7a9c2e1b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("clients") as batch_op:
        batch_op.add_column(sa.Column("slug", sa.String(length=140), nullable=True))

    op.execute(
        """
        UPDATE clients
        SET slug = lower(replace(name, ' ', '-')) || '-' || id
        WHERE slug IS NULL
        """
    )

    with op.batch_alter_table("clients") as batch_op:
        batch_op.alter_column("slug", existing_type=sa.String(length=140), nullable=False)
        batch_op.create_index("ix_clients_slug", ["slug"], unique=True)

    with op.batch_alter_table("device_groups") as batch_op:
        batch_op.add_column(sa.Column("description", sa.String(length=255), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("device_groups") as batch_op:
        batch_op.drop_column("description")

    with op.batch_alter_table("clients") as batch_op:
        batch_op.drop_index("ix_clients_slug")
        batch_op.drop_column("slug")
