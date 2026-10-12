"""Remote Support: password rotation grace and session tracking.

- devices.remote_support_password_previous_ciphertext: the password before the
  last change. The agent applies a new password on the heartbeat that delivers
  it, so until then Connect keeps using the previous one.
- devices.rustdesk_session_active / _started_at / _operator: a live Remote
  Support session as reported by the agent, for the session audit trail.

All nullable or with a constant default: metadata-only on PostgreSQL 11+,
no table rewrite.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
"""

import sqlalchemy as sa
from alembic import op

revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        # Heartbeats update devices rows all the time; never queue behind them.
        op.execute("SET LOCAL lock_timeout = '10s'")
    op.add_column("devices", sa.Column("remote_support_password_previous_ciphertext", sa.Text(), nullable=True))
    op.add_column(
        "devices",
        sa.Column("rustdesk_session_active", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column("devices", sa.Column("rustdesk_session_started_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("rustdesk_session_operator", sa.String(length=128), nullable=True))


def downgrade():
    op.drop_column("devices", "rustdesk_session_operator")
    op.drop_column("devices", "rustdesk_session_started_at")
    op.drop_column("devices", "rustdesk_session_active")
    op.drop_column("devices", "remote_support_password_previous_ciphertext")
