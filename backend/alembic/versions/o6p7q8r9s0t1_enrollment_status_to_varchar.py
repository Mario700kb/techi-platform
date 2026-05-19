"""Convert enrollment_tokens.status from native enum to VARCHAR(16)

Revision ID: o6p7q8r9s0t1
Revises: n5o6p7q8r9s0
Create Date: 2026-05-20 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op

revision: str = "o6p7q8r9s0t1"
down_revision: Union[str, None] = "n5o6p7q8r9s0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "ALTER TABLE enrollment_tokens "
            "ALTER COLUMN status TYPE VARCHAR(16) USING status::text"
        )
        op.execute("DROP TYPE IF EXISTS enrollmenttokenstatus")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "CREATE TYPE enrollmenttokenstatus AS ENUM "
            "('active', 'revoked', 'expired', 'used')"
        )
        op.execute(
            "ALTER TABLE enrollment_tokens "
            "ALTER COLUMN status TYPE enrollmenttokenstatus "
            "USING status::enrollmenttokenstatus"
        )
