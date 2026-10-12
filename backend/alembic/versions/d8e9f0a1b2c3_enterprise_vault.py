"""enterprise vault — credential metadata + assignments

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "d8e9f0a1b2c3"
down_revision = "c7d8e9f0a1b2"
branch_labels = None
depends_on = None


def _create_phase4_vault_tables() -> None:
    """The Phase 4 vault tables, as production has them.

    They were first created outside Alembic (2026-07-07), so on an existing
    database this is a no-op; on an empty one — a new environment, or a
    rebuild after a disaster — this revision would otherwise fail on a table
    that no migration ever created.
    """
    op.create_table(
        "vault_credentials",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("credential_type", sa.String(32), nullable=False),
        sa.Column("scope_type", sa.String(16), nullable=False, server_default="global"),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id"), nullable=True),
        sa.Column("group_id", sa.Integer(), sa.ForeignKey("device_groups.id"), nullable=True),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id"), nullable=True),
        sa.Column("username", sa.String(160), nullable=True),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("dek_wrapped", sa.Text(), nullable=False),
        sa.Column("notes", sa.String(500), nullable=True),
        sa.Column("created_by", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("rotated_at", sa.DateTime(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
    )
    for column in ("scope_type", "client_id", "group_id", "device_id"):
        op.create_index(f"ix_vault_credentials_{column}", "vault_credentials", [column])
    op.create_table(
        "vault_credential_usage",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("credential_id", sa.Integer(), sa.ForeignKey("vault_credentials.id"), nullable=False),
        sa.Column("operator_username", sa.String(128), nullable=True),
        sa.Column("device_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(24), nullable=False),
        sa.Column("reason", sa.String(300), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_vault_credential_usage_credential_id", "vault_credential_usage", ["credential_id"])
    op.create_index("ix_vault_credential_usage_created_at", "vault_credential_usage", ["created_at"])


def upgrade():
    inspector = inspect(op.get_bind())
    if "vault_credentials" not in set(inspector.get_table_names()):
        _create_phase4_vault_tables()
        inspector = inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    credential_columns = {column["name"] for column in inspector.get_columns("vault_credentials")}
    if "purpose" not in credential_columns:
        op.add_column("vault_credentials", sa.Column("purpose", sa.String(64), nullable=True))
    if "status" not in credential_columns:
        op.add_column(
            "vault_credentials",
            sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        )
    if "expires_at" not in credential_columns:
        op.add_column("vault_credentials", sa.Column("expires_at", sa.DateTime(), nullable=True))
    if "rotation_due_at" not in credential_columns:
        op.add_column("vault_credentials", sa.Column("rotation_due_at", sa.DateTime(), nullable=True))
    if "last_tested_at" not in credential_columns:
        op.add_column("vault_credentials", sa.Column("last_tested_at", sa.DateTime(), nullable=True))
    if "last_test_status" not in credential_columns:
        op.add_column("vault_credentials", sa.Column("last_test_status", sa.String(16), nullable=True))
    if "metadata_json" not in credential_columns:
        op.add_column("vault_credentials", sa.Column("metadata_json", sa.Text(), nullable=True))
    credential_indexes = {index["name"] for index in inspector.get_indexes("vault_credentials")}
    if "ix_vault_credentials_purpose" not in credential_indexes:
        op.create_index("ix_vault_credentials_purpose", "vault_credentials", ["purpose"])
    if "ix_vault_credentials_status" not in credential_indexes:
        op.create_index("ix_vault_credentials_status", "vault_credentials", ["status"])

    if "vault_credential_assignments" not in tables:
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
    assignment_indexes = {
        index["name"] for index in inspector.get_indexes("vault_credential_assignments")
    }
    if "ix_vault_credential_assignments_credential_id" not in assignment_indexes:
        op.create_index("ix_vault_credential_assignments_credential_id", "vault_credential_assignments", ["credential_id"])
    if "ix_vault_credential_assignments_client_id" not in assignment_indexes:
        op.create_index("ix_vault_credential_assignments_client_id", "vault_credential_assignments", ["client_id"])
    if "ix_vault_credential_assignments_device_id" not in assignment_indexes:
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
