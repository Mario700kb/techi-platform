"""add enrollment tokens

Revision ID: d4f7a9c2e1b0
Revises: 9b897773e6ad
Create Date: 2026-05-11 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "d4f7a9c2e1b0"
down_revision = "9b897773e6ad"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "enrollment_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "status",
            sa.Enum("active", "revoked", "expired", "used", name="enrollmenttokenstatus"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=False),
        sa.Column("use_count", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=True),
        sa.Column("group_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"]),
        sa.ForeignKeyConstraint(["group_id"], ["device_groups.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_enrollment_tokens_id", "enrollment_tokens", ["id"], unique=False)
    op.create_index("ix_enrollment_tokens_token_hash", "enrollment_tokens", ["token_hash"], unique=True)
    op.create_index("ix_enrollment_tokens_status", "enrollment_tokens", ["status"], unique=False)
    op.create_index("ix_enrollment_tokens_expires_at", "enrollment_tokens", ["expires_at"], unique=False)
    op.create_index("ix_enrollment_tokens_client_id", "enrollment_tokens", ["client_id"], unique=False)
    op.create_index("ix_enrollment_tokens_group_id", "enrollment_tokens", ["group_id"], unique=False)
    op.create_index(
        "ix_enrollment_tokens_status_expires_at",
        "enrollment_tokens",
        ["status", "expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_enrollment_tokens_client_group",
        "enrollment_tokens",
        ["client_id", "group_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_enrollment_tokens_client_group", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_status_expires_at", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_group_id", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_client_id", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_expires_at", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_status", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_token_hash", table_name="enrollment_tokens")
    op.drop_index("ix_enrollment_tokens_id", table_name="enrollment_tokens")
    op.drop_table("enrollment_tokens")
