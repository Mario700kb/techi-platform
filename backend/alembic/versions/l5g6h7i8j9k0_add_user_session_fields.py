"""add user_source and user_session_state to devices

Revision ID: l5g6h7i8j9k0
Revises: k4f5g6h7i8j9
Create Date: 2026-05-16
"""
from alembic import op
import sqlalchemy as sa

revision = "l5g6h7i8j9k0"
down_revision = "k4f5g6h7i8j9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.add_column(sa.Column("user_source", sa.String(40), nullable=True))
        batch_op.add_column(sa.Column("user_session_state", sa.String(40), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.drop_column("user_session_state")
        batch_op.drop_column("user_source")
