"""add enrollment audit

Revision ID: a2b3c4d5e6f7
Revises: z1a2b3c4d5e6
Create Date: 2026-06-11 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "a2b3c4d5e6f7"
down_revision = "z1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "enrollment_audit",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("token_id", sa.Integer(), nullable=True),
        sa.Column("token_name", sa.String(length=160), nullable=True),
        sa.Column("token_prefix", sa.String(length=12), nullable=True),
        sa.Column("client_id", sa.Integer(), nullable=True),
        sa.Column("group_id", sa.Integer(), nullable=True),
        sa.Column("device_id", sa.Integer(), nullable=True),
        sa.Column("hostname", sa.String(length=128), nullable=True),
        sa.Column("username", sa.String(length=128), nullable=True),
        sa.Column("domain", sa.String(length=128), nullable=True),
        sa.Column("rustdesk_id", sa.String(length=64), nullable=True),
        sa.Column("public_ip", sa.String(length=45), nullable=True),
        sa.Column("local_ip", sa.String(length=45), nullable=True),
        sa.Column("result", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.String(length=255), nullable=True),
        sa.Column("raw_error", sa.Text(), nullable=True),
        sa.Column("fingerprint", sa.String(length=255), nullable=True),
        sa.Column("agent_id", sa.String(length=80), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_enrollment_audit_id", "enrollment_audit", ["id"], unique=False)
    op.create_index("ix_enrollment_audit_token_id", "enrollment_audit", ["token_id"], unique=False)
    op.create_index("ix_enrollment_audit_created_at", "enrollment_audit", ["created_at"], unique=False)
    op.create_index("ix_enrollment_audit_device_id", "enrollment_audit", ["device_id"], unique=False)
    op.create_index("ix_enrollment_audit_result", "enrollment_audit", ["result"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_enrollment_audit_result", table_name="enrollment_audit")
    op.drop_index("ix_enrollment_audit_device_id", table_name="enrollment_audit")
    op.drop_index("ix_enrollment_audit_created_at", table_name="enrollment_audit")
    op.drop_index("ix_enrollment_audit_token_id", table_name="enrollment_audit")
    op.drop_index("ix_enrollment_audit_id", table_name="enrollment_audit")
    op.drop_table("enrollment_audit")
