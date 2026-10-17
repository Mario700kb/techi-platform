"""Telemetry pipeline: 1-minute samples, 5-minute and hourly rollups, delivery
state per device, monitoring policies

Revision ID: m3n4o5p6q7r8
Revises: l2m3n4o5p6q7

New tables only; nothing existing is rewritten. On PostgreSQL
telemetry_samples is partitioned by day (RANGE on ts) with partitions for the
last 7 days and the next 3; the nightly cleanup adds the coming days and drops
expired ones. Two policies are seeded: Workstations (every device) and Servers
(devices classified server), with the thresholds agreed on 17 Oct 2026.
"""
import json
from datetime import datetime, timedelta, timezone

import sqlalchemy as sa
from alembic import op

revision = "m3n4o5p6q7r8"
down_revision = "l2m3n4o5p6q7"
branch_labels = None
depends_on = None

WORKSTATION_MONITORS = [
    {"key": "cpu", "metric": "cpu", "op": ">", "threshold": 95, "duration_s": 900, "severity": "critical", "enabled": True},
    {"key": "mem", "metric": "mem", "op": ">", "threshold": 90, "duration_s": 600, "severity": "warning", "enabled": True},
    {"key": "disk", "metric": "disk", "op": ">", "threshold": 90, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "no_data", "metric": "no_data", "op": ">", "threshold": 0, "duration_s": 600, "severity": "critical", "enabled": True},
]
SERVER_MONITORS = WORKSTATION_MONITORS + [
    {"key": "disk_forecast", "metric": "disk_forecast_days", "op": "<", "threshold": 14, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "net_rx", "metric": "net_rx_mbps", "op": ">", "threshold": 800, "duration_s": 300, "severity": "info", "enabled": False},
]


def _rollup(name: str) -> None:
    op.create_table(
        name,
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("bucket", sa.DateTime(), primary_key=True),
        sa.Column("samples", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expected", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("late", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cpu_avg", sa.Float(), nullable=True),
        sa.Column("cpu_min", sa.Float(), nullable=True),
        sa.Column("cpu_max", sa.Float(), nullable=True),
        sa.Column("mem_avg", sa.Float(), nullable=True),
        sa.Column("mem_max", sa.Float(), nullable=True),
        sa.Column("net_rx_avg", sa.Float(), nullable=True),
        sa.Column("net_rx_max", sa.Float(), nullable=True),
        sa.Column("net_tx_avg", sa.Float(), nullable=True),
        sa.Column("net_tx_max", sa.Float(), nullable=True),
        sa.Column("disk_max", sa.Float(), nullable=True),
        sa.Column("disks", sa.JSON(), nullable=True),
    )
    op.create_index(f"ix_{name}_bucket", name, ["bucket"])


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # Monitors raise two new kinds of alert. alertkind belongs to the
        # database owner, not the application role that runs migrations, and
        # ALTER TYPE checks ownership even with IF NOT EXISTS: add a value
        # only when it is missing (the owner can add it beforehand).
        for value in ("disk_forecast", "high_network"):
            present = bind.execute(sa.text(
                "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
                "WHERE t.typname = 'alertkind' AND e.enumlabel = :v"
            ), {"v": value}).first()
            if present is None:
                op.execute(f"ALTER TYPE alertkind ADD VALUE IF NOT EXISTS '{value}'")
        op.execute(
            """
            CREATE TABLE telemetry_samples (
                device_id integer NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                ts timestamp without time zone NOT NULL,
                seq bigint NOT NULL,
                cpu double precision,
                mem double precision,
                mem_used_mb double precision,
                net_rx_bps double precision,
                net_tx_bps double precision,
                uptime_s bigint,
                disks json,
                source smallint NOT NULL DEFAULT 1,
                PRIMARY KEY (device_id, ts)
            ) PARTITION BY RANGE (ts)
            """
        )
        today = datetime.now(timezone.utc).date()
        for offset in range(-7, 4):
            day = today + timedelta(days=offset)
            nxt = day + timedelta(days=1)
            op.execute(
                f"CREATE TABLE telemetry_samples_{day:%Y%m%d} PARTITION OF telemetry_samples "
                f"FOR VALUES FROM ('{day.isoformat()}') TO ('{nxt.isoformat()}')"
            )
    else:
        op.create_table(
            "telemetry_samples",
            sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("ts", sa.DateTime(), primary_key=True),
            sa.Column("seq", sa.BigInteger(), nullable=False),
            sa.Column("cpu", sa.Float(), nullable=True),
            sa.Column("mem", sa.Float(), nullable=True),
            sa.Column("mem_used_mb", sa.Float(), nullable=True),
            sa.Column("net_rx_bps", sa.Float(), nullable=True),
            sa.Column("net_tx_bps", sa.Float(), nullable=True),
            sa.Column("uptime_s", sa.BigInteger(), nullable=True),
            sa.Column("disks", sa.JSON(), nullable=True),
            sa.Column("source", sa.SmallInteger(), nullable=False, server_default="1"),
        )

    _rollup("telemetry_rollup_5m")
    _rollup("telemetry_rollup_1h")

    op.create_table(
        "device_telemetry_state",
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("last_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("last_upload_at", sa.DateTime(), nullable=True),
        sa.Column("last_sample_at", sa.DateTime(), nullable=True),
        sa.Column("pending", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("oldest_pending_at", sa.DateTime(), nullable=True),
        sa.Column("dropped_total", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("clock_offset_ms", sa.Integer(), nullable=True),
        sa.Column("sample_seconds", sa.Integer(), nullable=True),
        sa.Column("policy_version", sa.String(length=64), nullable=True),
        sa.Column("schema", sa.SmallInteger(), nullable=True),
    )

    policies = op.create_table(
        "monitoring_policies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("scope_value", sa.String(length=64), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("sample_seconds", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("upload_seconds", sa.Integer(), nullable=False, server_default="900"),
        sa.Column("buffer_mb", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("keep_days", sa.Integer(), nullable=False, server_default="7"),
        sa.Column("monitors", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("updated_by", sa.String(length=120), nullable=True),
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    op.bulk_insert(policies, [
        {"name": "Workstations", "description": "Every device unless a more specific policy applies.",
         "scope": "default", "scope_value": None, "enabled": True, "version": 1, "sample_seconds": 60,
         "upload_seconds": 900, "buffer_mb": 50, "keep_days": 7, "monitors": json.loads(json.dumps(WORKSTATION_MONITORS)),
         "updated_at": now, "updated_by": "system"},
        {"name": "Servers", "description": "Every device classified as a server.",
         "scope": "device_type", "scope_value": "server", "enabled": True, "version": 1, "sample_seconds": 60,
         "upload_seconds": 900, "buffer_mb": 50, "keep_days": 7, "monitors": json.loads(json.dumps(SERVER_MONITORS)),
         "updated_at": now, "updated_by": "system"},
    ])


def downgrade() -> None:
    # PostgreSQL cannot remove enum values; disk_forecast and high_network stay.
    op.drop_table("monitoring_policies")
    op.drop_table("device_telemetry_state")
    op.drop_index("ix_telemetry_rollup_1h_bucket", table_name="telemetry_rollup_1h")
    op.drop_table("telemetry_rollup_1h")
    op.drop_index("ix_telemetry_rollup_5m_bucket", table_name="telemetry_rollup_5m")
    op.drop_table("telemetry_rollup_5m")
    op.drop_table("telemetry_samples")  # partitions go with the parent on PostgreSQL
