"""reconcile bootstrap and RustDesk schema drift

Revision ID: q8r9s0t1u2v3
Revises: p7q8r9s0t1u2
Create Date: 2026-05-21 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "q8r9s0t1u2v3"
down_revision = "p7q8r9s0t1u2"
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table_name)


def _columns(table_name: str) -> set[str]:
    if not _table_exists(table_name):
        return set()
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table_name)}


def _indexes(table_name: str) -> set[str]:
    if not _table_exists(table_name):
        return set()
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table_name)}


def _add_column_if_missing(table_name: str, column: sa.Column) -> None:
    if column.name not in _columns(table_name):
        op.add_column(table_name, column)


def _create_index_if_missing(index_name: str, table_name: str, columns: list[str], *, unique: bool = False) -> None:
    if index_name not in _indexes(table_name):
        op.create_index(index_name, table_name, columns, unique=unique)


def upgrade() -> None:
    _add_column_if_missing(
        "enrollment_tokens",
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _add_column_if_missing("enrollment_tokens", sa.Column("token_prefix", sa.String(length=12), nullable=True))
    _add_column_if_missing(
        "enrollment_tokens",
        sa.Column("is_internal", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _add_column_if_missing("enrollment_tokens", sa.Column("internal_kind", sa.String(length=32), nullable=True))
    _create_index_if_missing("ix_enrollment_tokens_is_default", "enrollment_tokens", ["is_default"])
    _create_index_if_missing("ix_enrollment_tokens_is_internal", "enrollment_tokens", ["is_internal"])
    _create_index_if_missing("ix_enrollment_tokens_internal_kind", "enrollment_tokens", ["internal_kind"])
    _create_index_if_missing(
        "ix_enrollment_tokens_internal_kind_status",
        "enrollment_tokens",
        ["internal_kind", "status"],
    )

    _add_column_if_missing(
        "device_heartbeats",
        sa.Column("rustdesk_install_status", sa.String(length=32), nullable=True),
    )
    _add_column_if_missing("device_heartbeats", sa.Column("rustdesk_status", sa.String(length=32), nullable=True))
    _add_column_if_missing("device_heartbeats", sa.Column("rustdesk_version", sa.String(length=80), nullable=True))
    _add_column_if_missing("device_heartbeats", sa.Column("rustdesk_install_path", sa.String(length=512), nullable=True))
    _create_index_if_missing(
        "ix_device_heartbeats_rustdesk_install_status",
        "device_heartbeats",
        ["rustdesk_install_status"],
    )
    _create_index_if_missing("ix_device_heartbeats_rustdesk_status", "device_heartbeats", ["rustdesk_status"])

    if not _table_exists("trusted_domains"):
        op.create_table(
            "trusted_domains",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("domain", sa.String(length=255), nullable=False),
            sa.Column("client_name", sa.String(length=160), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("domain"),
        )
    _create_index_if_missing("ix_trusted_domains_id", "trusted_domains", ["id"])
    _create_index_if_missing("ix_trusted_domains_domain", "trusted_domains", ["domain"])
    _create_index_if_missing("ix_trusted_domains_is_active", "trusted_domains", ["is_active"])


def downgrade() -> None:
    if _table_exists("device_heartbeats"):
        indexes = _indexes("device_heartbeats")
        for index_name in (
            "ix_device_heartbeats_rustdesk_status",
            "ix_device_heartbeats_rustdesk_install_status",
        ):
            if index_name in indexes:
                op.drop_index(index_name, table_name="device_heartbeats")
        existing = _columns("device_heartbeats")
        for column_name in (
            "rustdesk_install_path",
            "rustdesk_version",
            "rustdesk_status",
            "rustdesk_install_status",
        ):
            if column_name in existing:
                op.drop_column("device_heartbeats", column_name)

    if _table_exists("enrollment_tokens"):
        indexes = _indexes("enrollment_tokens")
        for index_name in ("ix_enrollment_tokens_internal_kind_status", "ix_enrollment_tokens_is_default"):
            if index_name in indexes:
                op.drop_index(index_name, table_name="enrollment_tokens")
        existing = _columns("enrollment_tokens")
        for column_name in ("token_prefix", "is_default"):
            if column_name in existing:
                op.drop_column("enrollment_tokens", column_name)
