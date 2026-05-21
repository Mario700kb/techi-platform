"""add recoverable enrollment token ciphertext

Revision ID: s0t1u2v3w4x5
Revises: r9s0t1u2v3w4
Create Date: 2026-05-21 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "s0t1u2v3w4x5"
down_revision = "r9s0t1u2v3w4"
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table_name)


def _columns(table_name: str) -> set[str]:
    if not _table_exists(table_name):
        return set()
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table_name)}


def upgrade() -> None:
    if "token_ciphertext" not in _columns("enrollment_tokens"):
        op.add_column("enrollment_tokens", sa.Column("token_ciphertext", sa.Text(), nullable=True))


def downgrade() -> None:
    if "token_ciphertext" in _columns("enrollment_tokens"):
        op.drop_column("enrollment_tokens", "token_ciphertext")
