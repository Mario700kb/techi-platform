"""add indexes to devices and device_heartbeats for query performance

Revision ID: w4x5y6z7a8b9
Revises: v3w4x5y6z7a8
Create Date: 2026-06-07 00:00:00.000000
"""
from alembic import op


revision = "w4x5y6z7a8b9"
down_revision = "v3w4x5y6z7a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # devices — columns used in filters, ordering, and reconciliation
    op.create_index("ix_devices_hostname", "devices", ["hostname"], if_not_exists=True)
    op.create_index("ix_devices_last_seen", "devices", ["last_seen"], if_not_exists=True)
    op.create_index("ix_devices_client_id", "devices", ["client_id"], if_not_exists=True)
    op.create_index("ix_devices_rustdesk_id", "devices", ["rustdesk_id"], if_not_exists=True)
    op.create_index("ix_devices_status", "devices", ["status"], if_not_exists=True)
    op.create_index("ix_devices_domain", "devices", ["domain"], if_not_exists=True)
    op.create_index("ix_devices_device_type", "devices", ["device_type"], if_not_exists=True)

    # device_heartbeats — used in cleanup / retention queries
    op.create_index("ix_device_heartbeats_device_id", "device_heartbeats", ["device_id"], if_not_exists=True)
    op.create_index("ix_device_heartbeats_created_at", "device_heartbeats", ["created_at"], if_not_exists=True)


def downgrade() -> None:
    op.drop_index("ix_device_heartbeats_created_at", table_name="device_heartbeats", if_exists=True)
    op.drop_index("ix_device_heartbeats_device_id", table_name="device_heartbeats", if_exists=True)
    op.drop_index("ix_devices_device_type", table_name="devices", if_exists=True)
    op.drop_index("ix_devices_domain", table_name="devices", if_exists=True)
    op.drop_index("ix_devices_status", table_name="devices", if_exists=True)
    op.drop_index("ix_devices_rustdesk_id", table_name="devices", if_exists=True)
    op.drop_index("ix_devices_client_id", table_name="devices", if_exists=True)
    op.drop_index("ix_devices_last_seen", table_name="devices", if_exists=True)
    op.drop_index("ix_devices_hostname", table_name="devices", if_exists=True)
