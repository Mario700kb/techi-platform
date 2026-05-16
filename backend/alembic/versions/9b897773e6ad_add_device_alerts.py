"""Add device_alerts table.

Revision ID: 9b897773e6ad
Revises: 7d7326216240
Create Date: 2026-05-11 14:57:32.410128
"""
from alembic import op
import sqlalchemy as sa

revision = '9b897773e6ad'
down_revision = '7d7326216240'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_alerts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column(
            "kind",
            sa.Enum(
                "device_offline",
                "repeated_reconnects",
                "high_cpu",
                "high_ram",
                "low_disk",
                "rustdesk_sync_failure",
                "heartbeat_stale",
                "telemetry_missing",
                name="alertkind",
            ),
            nullable=False,
        ),
        sa.Column(
            "severity",
            sa.Enum("info", "warning", "critical", name="alertseverity"),
            nullable=False,
        ),
        sa.Column(
            "state",
            sa.Enum("open", "resolved", name="alertstate"),
            nullable=False,
        ),
        sa.Column("message", sa.String(512), nullable=False),
        sa.Column("detail", sa.String(1024), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(), nullable=True),
        sa.Column("cooldown_until", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_device_alerts_id", "device_alerts", ["id"])
    op.create_index("ix_device_alerts_device_id", "device_alerts", ["device_id"])
    op.create_index("ix_device_alerts_kind", "device_alerts", ["kind"])
    op.create_index("ix_device_alerts_state", "device_alerts", ["state"])
    op.create_index(
        "ix_device_alerts_device_kind_state",
        "device_alerts",
        ["device_id", "kind", "state"],
    )


def downgrade() -> None:
    op.drop_index("ix_device_alerts_device_kind_state", table_name="device_alerts")
    op.drop_index("ix_device_alerts_state", table_name="device_alerts")
    op.drop_index("ix_device_alerts_kind", table_name="device_alerts")
    op.drop_index("ix_device_alerts_device_id", table_name="device_alerts")
    op.drop_index("ix_device_alerts_id", table_name="device_alerts")
    op.drop_table("device_alerts")
