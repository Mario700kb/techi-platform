"""Remote Support identity: the client's own report of its ID

Revision ID: w1x2y3z4a5b6
Revises: v0w1x2y3z4a5

TECHI Remote Support posts {id, uuid} to the platform every 15 seconds; it was
taken for a legacy agent heartbeat and dropped. remote_support_peers keeps
what each client says about itself; devices gain where their rustdesk_id came
from, when the client last reported, the ID the agent reported when it
disagrees, and the MachineGuid the uuid encodes. New table and nullable
columns only.
"""
import sqlalchemy as sa
from alembic import op

revision = "w1x2y3z4a5b6"
down_revision = "v0w1x2y3z4a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_support_peers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("uuid", sa.String(length=128), nullable=False),
        sa.Column("machine_guid", sa.String(length=64), nullable=True),
        sa.Column("rustdesk_id", sa.String(length=32), nullable=False),
        sa.Column("hostname", sa.String(length=255), nullable=True),
        sa.Column("username", sa.String(length=255), nullable=True),
        sa.Column("os", sa.String(length=255), nullable=True),
        sa.Column("version", sa.String(length=32), nullable=True),
        sa.Column("source_ip", sa.String(length=64), nullable=True),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="SET NULL"), nullable=True),
        sa.Column("bound_by", sa.String(length=16), nullable=True),
        sa.Column("bound_at", sa.DateTime(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("sysinfo_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.UniqueConstraint("uuid", "rustdesk_id", name="uq_remote_support_peers_uuid_id"),
    )
    op.create_index("ix_remote_support_peers_uuid", "remote_support_peers", ["uuid"])
    op.create_index("ix_remote_support_peers_rustdesk_id", "remote_support_peers", ["rustdesk_id"])
    op.create_index("ix_remote_support_peers_machine_guid", "remote_support_peers", ["machine_guid"])
    op.create_index("ix_remote_support_peers_device_id", "remote_support_peers", ["device_id"])
    op.create_index("ix_remote_support_peers_last_seen_at", "remote_support_peers", ["last_seen_at"])
    op.add_column("devices", sa.Column("rustdesk_id_source", sa.String(length=16), nullable=True))
    op.add_column("devices", sa.Column("rustdesk_presence_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("agent_rustdesk_id", sa.String(length=32), nullable=True))
    op.add_column("devices", sa.Column("machine_guid", sa.String(length=64), nullable=True))
    op.create_index("ix_devices_machine_guid", "devices", ["machine_guid"])


def downgrade() -> None:
    op.drop_index("ix_devices_machine_guid", table_name="devices")
    for column in ("machine_guid", "agent_rustdesk_id", "rustdesk_presence_at", "rustdesk_id_source"):
        op.drop_column("devices", column)
    for index in ("last_seen_at", "device_id", "machine_guid", "rustdesk_id", "uuid"):
        op.drop_index(f"ix_remote_support_peers_{index}", table_name="remote_support_peers")
    op.drop_table("remote_support_peers")
