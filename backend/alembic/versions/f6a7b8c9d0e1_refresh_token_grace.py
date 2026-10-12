"""operator_sessions: the previous refresh token, for a short grace period.

Tabs of one browser share the refresh cookie and renew at the same moment;
the first rotates the token and the rest arrived with the old one and were
signed out (production: operators signing in several times a day, four
sessions in one minute). The replaced token now stays valid for 30 seconds.

Nullable columns plus an index: metadata-only, small table.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
"""

import sqlalchemy as sa
from alembic import op

revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '10s'")
    op.add_column("operator_sessions", sa.Column("previous_refresh_token_hash", sa.String(length=64), nullable=True))
    op.add_column("operator_sessions", sa.Column("refresh_rotated_at", sa.DateTime(), nullable=True))
    op.create_index(
        "ix_operator_sessions_previous_refresh_token_hash", "operator_sessions", ["previous_refresh_token_hash"]
    )


def downgrade():
    op.drop_index("ix_operator_sessions_previous_refresh_token_hash", table_name="operator_sessions")
    op.drop_column("operator_sessions", "refresh_rotated_at")
    op.drop_column("operator_sessions", "previous_refresh_token_hash")
