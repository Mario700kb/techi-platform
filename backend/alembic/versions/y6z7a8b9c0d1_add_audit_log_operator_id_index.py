"""add index on audit_logs.operator_id

Revision ID: y6z7a8b9c0d1
Revises: x5y6z7a8b9c0
Create Date: 2026-06-09 00:00:00.000000
"""
from alembic import op
from sqlalchemy import text

revision = "y6z7a8b9c0d1"
down_revision = "x5y6z7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        op.create_index(
            "ix_audit_logs_operator_id",
            "audit_logs",
            ["operator_id"],
            if_not_exists=True,
        )
        return

    with op.get_context().autocommit_block():
        op.execute(text(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS "
            "ix_audit_logs_operator_id "
            "ON audit_logs (operator_id)"
        ))


def downgrade() -> None:
    op.drop_index(
        "ix_audit_logs_operator_id",
        table_name="audit_logs",
        if_exists=True,
    )
