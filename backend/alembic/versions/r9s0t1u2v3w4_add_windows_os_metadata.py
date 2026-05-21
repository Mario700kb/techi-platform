"""add Windows OS metadata for server classification

Revision ID: r9s0t1u2v3w4
Revises: q8r9s0t1u2v3
Create Date: 2026-05-21 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "r9s0t1u2v3w4"
down_revision = "q8r9s0t1u2v3"
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


def _create_index_if_missing(index_name: str, table_name: str, columns: list[str]) -> None:
    if index_name not in _indexes(table_name):
        op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    for table_name in ("devices", "device_heartbeats"):
        _add_column_if_missing(table_name, sa.Column("os_caption", sa.String(length=160), nullable=True))
        _add_column_if_missing(table_name, sa.Column("os_build", sa.String(length=80), nullable=True))
        _add_column_if_missing(table_name, sa.Column("windows_product_type", sa.Integer(), nullable=True))

    _create_index_if_missing("ix_devices_windows_product_type", "devices", ["windows_product_type"])
    _create_index_if_missing(
        "ix_device_heartbeats_windows_product_type",
        "device_heartbeats",
        ["windows_product_type"],
    )


def downgrade() -> None:
    for table_name, index_name in (
        ("device_heartbeats", "ix_device_heartbeats_windows_product_type"),
        ("devices", "ix_devices_windows_product_type"),
    ):
        if _table_exists(table_name) and index_name in _indexes(table_name):
            op.drop_index(index_name, table_name=table_name)

    for table_name in ("device_heartbeats", "devices"):
        if not _table_exists(table_name):
            continue
        existing = _columns(table_name)
        for column_name in ("windows_product_type", "os_build", "os_caption"):
            if column_name in existing:
                op.drop_column(table_name, column_name)
