"""Server-side browser sessions and TOTP two-factor authentication.

operator_sessions holds one row per signed-in browser (refresh token hash,
expiry, revocation). operators gains the MFA columns; every existing
operator starts with MFA off, so nobody is locked out by the upgrade.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
"""

from alembic import op
import sqlalchemy as sa


revision = "f2a3b4c5d6e7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "operator_sessions",
        sa.Column("id", sa.String(43), primary_key=True),
        sa.Column("operator_id", sa.Integer(), sa.ForeignKey("operators.id", ondelete="CASCADE"), nullable=False),
        sa.Column("refresh_token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("mfa_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("ip_address", sa.String(64), nullable=True),
        sa.Column("user_agent", sa.String(300), nullable=True),
    )
    op.create_index("ix_operator_sessions_operator_id", "operator_sessions", ["operator_id"])

    with op.batch_alter_table("operators") as batch:
        batch.add_column(sa.Column("mfa_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("mfa_secret_ciphertext", sa.Text(), nullable=True))
        batch.add_column(sa.Column("mfa_secret_dek", sa.Text(), nullable=True))
        batch.add_column(sa.Column("mfa_pending_ciphertext", sa.Text(), nullable=True))
        batch.add_column(sa.Column("mfa_pending_dek", sa.Text(), nullable=True))
        batch.add_column(sa.Column("mfa_recovery_codes", sa.Text(), nullable=True))
        batch.add_column(sa.Column("mfa_last_step", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("mfa_enabled_at", sa.DateTime(), nullable=True))


def downgrade():
    with op.batch_alter_table("operators") as batch:
        for column in (
            "mfa_enabled_at", "mfa_last_step", "mfa_recovery_codes", "mfa_pending_dek",
            "mfa_pending_ciphertext", "mfa_secret_dek", "mfa_secret_ciphertext", "mfa_enabled",
        ):
            batch.drop_column(column)
    op.drop_index("ix_operator_sessions_operator_id", table_name="operator_sessions")
    op.drop_table("operator_sessions")
