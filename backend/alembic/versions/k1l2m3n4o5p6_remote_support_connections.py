"""Remote Support connections reported by RustDesk itself

Revision ID: k1l2m3n4o5p6
Revises: j0k1l2m3n4o5

RustDesk on every device posts each incoming connection to the API server's
/api/audit/conn (opened, password accepted, closed); until now those posts
got a 404. This table keeps them, so sessions, their operators' machines,
their length and their drops are known without a new agent. A new, empty
table: nothing is rewritten or locked.
"""
import sqlalchemy as sa
from alembic import op

revision = "k1l2m3n4o5p6"
down_revision = "j0k1l2m3n4o5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_support_connections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("conn_id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.String(length=32), nullable=True),
        sa.Column("peer_id", sa.String(length=64), nullable=True),
        sa.Column("peer_name", sa.String(length=128), nullable=True),
        sa.Column("peer_ip", sa.String(length=64), nullable=True),
        sa.Column("conn_type", sa.Integer(), nullable=True),
        sa.Column("opened_at", sa.DateTime(), nullable=False),
        sa.Column("authorized_at", sa.DateTime(), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_remote_support_connections_device_conn", "remote_support_connections", ["device_id", "conn_id"]
    )
    op.create_index("ix_remote_support_connections_opened_at", "remote_support_connections", ["opened_at"])


def downgrade() -> None:
    op.drop_index("ix_remote_support_connections_opened_at", table_name="remote_support_connections")
    op.drop_index("ix_remote_support_connections_device_conn", table_name="remote_support_connections")
    op.drop_table("remote_support_connections")
