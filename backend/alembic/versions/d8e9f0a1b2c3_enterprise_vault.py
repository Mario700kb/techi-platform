"""enterprise vault — credential metadata + assignments

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
"""

from alembic import op
import sqlalchemy as sa


revision = "d8e9f0a1b2c3"
down_revision = "c7d8e9f0a1b2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("vault_credentials", sa.Column("purpose", sa.String(64), nullable=True))
    op.add_column(
        "vault_credentials",
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
    )
    op.add_column("vault_credentials", sa.Column("expires_at", sa.DateTime(), nullable=True))
    op.add_column("vault_credentials", sa.Column("rotation_due_at", sa.DateTime(), nullable=True))
    op.add_column("vault_credentials", sa.Column("last_tested_at", sa.DateTime(), nullable=True))
    op.add_column("vault_credentials", sa.Column("last_test_status", sa.String(16), nullable=True))
    op.add_column("vault_credentials", sa.Column("metadata_json", sa.Text(), nullable=True))
    op.create_index("ix_vault_credentials_purpose", "vault_credentials", ["purpose"])
    op.create_index("ix_vault_credentials_status", "vault_credentials", ["status"])

    op.create_table(
        "vault_credential_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "credential_id",
            sa.Integer(),
            sa.ForeignKey("vault_credentials.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id"), nullable=True),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id"), nullable=True),
        sa.Column("created_by", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_vault_credential_assignments_credential_id", "vault_credential_assignments", ["credential_id"])
    op.create_index("ix_vault_credential_assignments_client_id", "vault_credential_assignments", ["client_id"])
    op.create_index("ix_vault_credential_assignments_device_id", "vault_credential_assignments", ["device_id"])


def downgrade():
    op.drop_table("vault_credential_assignments")
    op.drop_index("ix_vault_credentials_status", table_name="vault_credentials")
    op.drop_index("ix_vault_credentials_purpose", table_name="vault_credentials")
    op.drop_column("vault_credentials", "metadata_json")
    op.drop_column("vault_credentials", "last_test_status")
    op.drop_column("vault_credentials", "last_tested_at")
    op.drop_column("vault_credentials", "rotation_due_at")
    op.drop_column("vault_credentials", "expires_at")
    op.drop_column("vault_credentials", "status")
    op.drop_column("vault_credentials", "purpose")
