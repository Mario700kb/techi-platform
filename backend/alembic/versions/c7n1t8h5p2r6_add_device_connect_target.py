"""Add per-device Connect target (host + port).

The Connect launcher built its URL from `local_ip or public_ip` and never
appended a port, so a MikroTik reached on its public address got a LAN URL
(`winbox://192.168.88.1`) and a service on a non-default port (Winbox on
8292/8293) could not be expressed at all.

Both columns are nullable and default to NULL: with nothing set the launcher
keeps using the reported addresses, so no existing device changes behaviour on
account of this migration.

Revision ID: c7n1t8h5p2r6
Revises: mrg8b3f1c2a9
Create Date: 2026-08-06
"""
from alembic import op
import sqlalchemy as sa

revision = "c7n1t8h5p2r6"
down_revision = "mrg8b3f1c2a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("connect_host", sa.String(length=255), nullable=True))
    op.add_column("devices", sa.Column("connect_port", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "connect_port")
    op.drop_column("devices", "connect_host")
