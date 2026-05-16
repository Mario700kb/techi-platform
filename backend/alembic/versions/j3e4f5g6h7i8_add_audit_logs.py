"""add_audit_logs

Revision ID: j3e4f5g6h7i8
Revises: i2d3e5f7b0c4
Create Date: 2026-05-13

"""
from alembic import op
import sqlalchemy as sa

revision = "j3e4f5g6h7i8"
down_revision = "i2d3e5f7b0c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("operator_id", sa.Integer(), nullable=True),
        sa.Column("operator_username", sa.String(128), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("entity_type", sa.String(64), nullable=True),
        sa.Column("entity_id", sa.Integer(), nullable=True),
        sa.Column("details_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_logs_id", "audit_logs", ["id"])
    op.create_index("ix_audit_logs_operator_username", "audit_logs", ["operator_username"])
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    op.create_index("ix_audit_logs_entity_type", "audit_logs", ["entity_type"])
    op.create_index("ix_audit_logs_created_at", "audit_logs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_audit_logs_created_at", "audit_logs")
    op.drop_index("ix_audit_logs_entity_type", "audit_logs")
    op.drop_index("ix_audit_logs_action", "audit_logs")
    op.drop_index("ix_audit_logs_operator_username", "audit_logs")
    op.drop_index("ix_audit_logs_id", "audit_logs")
    op.drop_table("audit_logs")
