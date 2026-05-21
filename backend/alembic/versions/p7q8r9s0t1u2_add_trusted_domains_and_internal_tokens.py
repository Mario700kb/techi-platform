"""add trusted domains and internal bootstrap tokens

Revision ID: p7q8r9s0t1u2
Revises: o6p7q8r9s0t1
Create Date: 2026-05-21 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "p7q8r9s0t1u2"
down_revision = "o6p7q8r9s0t1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("enrollment_tokens", sa.Column("is_internal", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("enrollment_tokens", sa.Column("internal_kind", sa.String(length=32), nullable=True))
    op.create_index("ix_enrollment_tokens_is_internal", "enrollment_tokens", ["is_internal"], unique=False)
    op.create_index("ix_enrollment_tokens_internal_kind", "enrollment_tokens", ["internal_kind"], unique=False)

    op.create_table(
        "trusted_domains",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("domain", sa.String(length=255), nullable=False),
        sa.Column("client_name", sa.String(length=160), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("domain"),
    )
    op.create_index("ix_trusted_domains_id", "trusted_domains", ["id"], unique=False)
    op.create_index("ix_trusted_domains_domain", "trusted_domains", ["domain"], unique=False)
    op.create_index("ix_trusted_domains_is_active", "trusted_domains", ["is_active"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_trusted_domains_is_active", table_name="trusted_domains")
    op.drop_index("ix_trusted_domains_domain", table_name="trusted_domains")
    op.drop_index("ix_trusted_domains_id", table_name="trusted_domains")
    op.drop_table("trusted_domains")
    op.drop_index("ix_enrollment_tokens_internal_kind", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_is_internal", table_name="enrollment_tokens")
    op.drop_column("enrollment_tokens", "internal_kind")
    op.drop_column("enrollment_tokens", "is_internal")
