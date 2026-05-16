"""add_operator_scopes

Revision ID: i2d3e5f7b0c4
Revises: h1c2e4f6b9d3
Create Date: 2026-05-13

"""
from alembic import op
import sqlalchemy as sa

revision = "i2d3e5f7b0c4"
down_revision = "h1c2e4f6b9d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "operator_scopes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("operator_id", sa.Integer(), nullable=False),
        sa.Column("scope_type", sa.String(16), nullable=False),
        sa.Column("scope_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["operator_id"], ["operators.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("operator_id", "scope_type", "scope_id", name="uq_operator_scope"),
    )
    op.create_index("ix_operator_scopes_id", "operator_scopes", ["id"])
    op.create_index("ix_operator_scopes_operator_id", "operator_scopes", ["operator_id"])


def downgrade() -> None:
    op.drop_index("ix_operator_scopes_operator_id", table_name="operator_scopes")
    op.drop_index("ix_operator_scopes_id", table_name="operator_scopes")
    op.drop_table("operator_scopes")
