"""add one-use Remote Support connect tokens

Revision ID: v6w7x8y9z0a1
Revises: u5v6w7x8y9z0
"""

from alembic import op
import sqlalchemy as sa


revision = "v6w7x8y9z0a1"
down_revision = "u5v6w7x8y9z0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_support_connect_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("receipt_hash", sa.String(length=64), nullable=True),
        sa.Column("purpose", sa.String(length=64), nullable=False),
        sa.Column("operator_id", sa.Integer(), nullable=False),
        sa.Column("operator_username", sa.String(length=80), nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("remote_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("reported_at", sa.DateTime(), nullable=True),
        sa.Column("launch_result", sa.String(length=32), nullable=True),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["operator_id"], ["operators.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_remote_support_connect_tokens_id", "remote_support_connect_tokens", ["id"])
    op.create_index(
        "ix_remote_support_connect_tokens_token_hash",
        "remote_support_connect_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        "ix_remote_support_connect_tokens_receipt_hash",
        "remote_support_connect_tokens",
        ["receipt_hash"],
        unique=True,
    )
    for column in ("operator_id", "client_id", "device_id", "expires_at"):
        op.create_index(
            f"ix_remote_support_connect_tokens_{column}",
            "remote_support_connect_tokens",
            [column],
        )
    op.create_index(
        "ix_rs_connect_tokens_device_created",
        "remote_support_connect_tokens",
        ["device_id", "created_at"],
    )
    op.create_index(
        "ix_rs_connect_tokens_expires_consumed",
        "remote_support_connect_tokens",
        ["expires_at", "consumed_at"],
    )


def downgrade() -> None:
    op.drop_table("remote_support_connect_tokens")
