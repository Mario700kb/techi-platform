"""add Remote Support repair and sync contract fields

Revision ID: t4u5v6w7x8y9
Revises: s3t4u5v6w7x8
"""

from alembic import op
import sqlalchemy as sa


revision = "t4u5v6w7x8y9"
down_revision = "s3t4u5v6w7x8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("rustdesk_repair_attempt_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("devices", sa.Column("rustdesk_repair_success_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("devices", sa.Column("rustdesk_consecutive_repair_failures", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("devices", sa.Column("rustdesk_last_repair_reason", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "rustdesk_last_repair_reason")
    op.drop_column("devices", "rustdesk_consecutive_repair_failures")
    op.drop_column("devices", "rustdesk_repair_success_count")
    op.drop_column("devices", "rustdesk_repair_attempt_count")
