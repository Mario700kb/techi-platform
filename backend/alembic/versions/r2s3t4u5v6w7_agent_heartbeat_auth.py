"""add device-bound Agent heartbeat authentication

Revision ID: r2s3t4u5v6w7
Revises: d8e9f0a1b2c3, e6f7a8b9c0d1
"""

from alembic import op
import sqlalchemy as sa


revision = "r2s3t4u5v6w7"
down_revision = ("d8e9f0a1b2c3", "e6f7a8b9c0d1")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("agent_auth_secret_ciphertext", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column("agent_auth_secret_wrapped_dek", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column("agent_auth_key_hash", sa.String(length=64), nullable=True))
    op.add_column("devices", sa.Column("agent_auth_issued_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("agent_auth_revoked_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("agent_auth_last_timestamp_ms", sa.BigInteger(), nullable=True))
    op.add_column("devices", sa.Column("agent_auth_last_nonce", sa.String(length=64), nullable=True))
    op.add_column("devices", sa.Column("remote_support_password_wrapped_dek", sa.Text(), nullable=True))
    op.create_index("ix_devices_agent_auth_key_hash", "devices", ["agent_auth_key_hash"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_devices_agent_auth_key_hash", table_name="devices")
    op.drop_column("devices", "remote_support_password_wrapped_dek")
    op.drop_column("devices", "agent_auth_last_nonce")
    op.drop_column("devices", "agent_auth_last_timestamp_ms")
    op.drop_column("devices", "agent_auth_revoked_at")
    op.drop_column("devices", "agent_auth_issued_at")
    op.drop_column("devices", "agent_auth_key_hash")
    op.drop_column("devices", "agent_auth_secret_wrapped_dek")
    op.drop_column("devices", "agent_auth_secret_ciphertext")
