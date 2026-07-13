"""add acknowledged Remote Support credential generations

Revision ID: s3t4u5v6w7x8
Revises: r2s3t4u5v6w7
"""

from alembic import op
import sqlalchemy as sa


revision = "s3t4u5v6w7x8"
down_revision = "r2s3t4u5v6w7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = [
        sa.Column("remote_support_active_generation", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("remote_support_desired_generation", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("remote_support_desired_password_ciphertext", sa.Text(), nullable=True),
        sa.Column("remote_support_desired_password_wrapped_dek", sa.Text(), nullable=True),
        sa.Column("remote_support_desired_source", sa.String(length=16), nullable=True),
        sa.Column("remote_support_desired_created_at", sa.DateTime(), nullable=True),
        sa.Column("remote_support_verification_key_ciphertext", sa.Text(), nullable=True),
        sa.Column("remote_support_verification_key_wrapped_dek", sa.Text(), nullable=True),
        sa.Column("remote_support_expected_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("remote_support_applied_generation", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("remote_support_applied_at", sa.DateTime(), nullable=True),
        sa.Column("remote_support_applied_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("remote_support_apply_status", sa.String(length=32), nullable=False, server_default="unsupported_legacy"),
        sa.Column("remote_support_failure_reason", sa.String(length=255), nullable=True),
    ]
    for column in columns:
        op.add_column("devices", column)


def downgrade() -> None:
    for name in [
        "remote_support_failure_reason",
        "remote_support_apply_status",
        "remote_support_applied_fingerprint",
        "remote_support_applied_at",
        "remote_support_applied_generation",
        "remote_support_expected_fingerprint",
        "remote_support_verification_key_wrapped_dek",
        "remote_support_verification_key_ciphertext",
        "remote_support_desired_created_at",
        "remote_support_desired_source",
        "remote_support_desired_password_wrapped_dek",
        "remote_support_desired_password_ciphertext",
        "remote_support_desired_generation",
        "remote_support_active_generation",
    ]:
        op.drop_column("devices", name)
