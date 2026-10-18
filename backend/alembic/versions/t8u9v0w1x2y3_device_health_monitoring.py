"""Disk activity, network quality, top processes and device health

Revision ID: t8u9v0w1x2y3
Revises: s7t8u9v0w1x2
Create Date: 2026-10-18 23:30:00.000000

Agent 2.1.33 adds to each 1-minute sample: disk busy %, queue, read/write
bytes/s, gateway round trip and loss, platform connect time and — in busy
minutes — the top processes. The rollups keep their average and peak. All
columns are nullable REAL/JSON with no default, so adding them rewrites
nothing (on PostgreSQL the partitions of telemetry_samples inherit them).

device_inventory keeps the device's health report (physical disks, pending
restart, critical System events).

Eight alert kinds are added. alertkind belongs to the database owner, not the
role that runs migrations, and ALTER TYPE checks ownership even with IF NOT
EXISTS: a value is added only when missing, so the owner can add them first
(docs: run as role techi).

The default policy gains the report monitors (security score, disk health,
critical events, pending restart) and the 2.1.33 sample monitors (disk
activity, gateway latency and loss); the Servers policy gains a service
monitor for the usual server roles. Only keys a policy does not have yet are
added, and each policy changed moves to its next version.
"""
import json
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "t8u9v0w1x2y3"
down_revision: Union[str, None] = "s7t8u9v0w1x2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NEW_KINDS = (
    "disk_busy", "network_latency", "packet_loss", "service_stopped",
    "disk_health", "critical_events", "reboot_pending", "security_posture",
)
SAMPLE_COLUMNS = ("disk_busy", "disk_queue", "disk_read_bps", "disk_write_bps", "gw_ms", "gw_loss", "wan_ms")
ROLLUP_COLUMNS = (
    "disk_busy_avg", "disk_busy_max", "disk_queue_avg", "disk_queue_max", "disk_read_avg", "disk_read_max",
    "disk_write_avg", "disk_write_max", "gw_ms_avg", "gw_ms_max", "gw_loss_avg", "gw_loss_max",
    "wan_ms_avg", "wan_ms_max",
)

DEFAULT_MONITORS = [
    {"key": "security", "metric": "security_score", "op": "<", "threshold": 70, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "disk_health", "metric": "disk_health", "op": ">", "threshold": 0, "duration_s": 0, "severity": "critical", "enabled": True},
    {"key": "critical_events", "metric": "critical_events", "op": ">", "threshold": 0, "duration_s": 0, "severity": "warning", "enabled": True},
    {"key": "reboot_pending", "metric": "reboot_pending_days", "op": ">", "threshold": 7, "duration_s": 0, "severity": "info", "enabled": True},
    {"key": "disk_busy", "metric": "disk_busy", "op": ">", "threshold": 90, "duration_s": 1200, "severity": "info", "enabled": True},
    {"key": "gw_loss", "metric": "gw_loss", "op": ">", "threshold": 20, "duration_s": 600, "severity": "warning", "enabled": True},
    {"key": "gw_latency", "metric": "gw_ms", "op": ">", "threshold": 150, "duration_s": 600, "severity": "info", "enabled": True},
]
SERVER_MONITORS = [
    {"key": "services", "metric": "service", "op": ">", "threshold": 0, "duration_s": 300, "severity": "critical", "enabled": True,
     "target": "MSSQL*, SQLAgent*, SQLSERVERAGENT, vmms, NTDS, DNS, DHCPServer, Netlogon, DFSR, LanmanServer, W32Time, Veeam*"},
]


def _add_monitors(bind, where: str, monitors: list) -> None:
    policies = sa.table(
        "monitoring_policies",
        sa.column("id", sa.Integer), sa.column("monitors", sa.JSON), sa.column("version", sa.Integer),
        sa.column("updated_at", sa.DateTime), sa.column("updated_by", sa.String),
    )
    rows = bind.execute(sa.text(f"SELECT id, monitors, version FROM monitoring_policies WHERE {where}")).fetchall()
    for policy_id, current, version in rows:
        if isinstance(current, str):
            current = json.loads(current)
        current = list(current or [])
        keys = {m.get("key") for m in current}
        added = [m for m in monitors if m["key"] not in keys]
        if not added:
            continue
        bind.execute(
            policies.update().where(policies.c.id == policy_id).values(
                monitors=current + added, version=(version or 0) + 1,
                updated_at=datetime.now(timezone.utc).replace(tzinfo=None), updated_by="system",
            )
        )


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for value in NEW_KINDS:
            present = bind.execute(sa.text(
                "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
                "WHERE t.typname = 'alertkind' AND e.enumlabel = :v"
            ), {"v": value}).first()
            has_type = bind.execute(sa.text("SELECT 1 FROM pg_type WHERE typname = 'alertkind'")).first()
            if has_type is not None and present is None:
                op.execute(f"ALTER TYPE alertkind ADD VALUE IF NOT EXISTS '{value}'")

    for column in SAMPLE_COLUMNS:
        op.add_column("telemetry_samples", sa.Column(column, sa.REAL(), nullable=True))
    op.add_column("telemetry_samples", sa.Column("top", sa.JSON(), nullable=True))
    for table in ("telemetry_rollup_5m", "telemetry_rollup_1h"):
        for column in ROLLUP_COLUMNS:
            op.add_column(table, sa.Column(column, sa.REAL(), nullable=True))
        op.add_column(table, sa.Column("top", sa.JSON(), nullable=True))

    op.add_column("device_inventory", sa.Column("health_json", sa.Text(), nullable=True))
    op.add_column("device_inventory", sa.Column("health_collected_at", sa.DateTime(), nullable=True))

    _add_monitors(bind, "scope = 'default'", DEFAULT_MONITORS)
    _add_monitors(bind, "scope = 'device_type' AND scope_value IN ('server', 'servers')", SERVER_MONITORS)


def downgrade() -> None:
    op.drop_column("device_inventory", "health_collected_at")
    op.drop_column("device_inventory", "health_json")
    for table in ("telemetry_rollup_1h", "telemetry_rollup_5m"):
        op.drop_column(table, "top")
        for column in reversed(ROLLUP_COLUMNS):
            op.drop_column(table, column)
    op.drop_column("telemetry_samples", "top")
    for column in reversed(SAMPLE_COLUMNS):
        op.drop_column("telemetry_samples", column)
    # The platform before this revision refuses a policy holding a metric it
    # does not know, so every monitor of a new metric is taken out again.
    # Alert kinds stay (PostgreSQL cannot drop an enum value).
    bind = op.get_bind()
    new_metrics = {"disk_busy", "gw_ms", "gw_loss", "service", "disk_health", "critical_events",
                   "reboot_pending_days", "security_score"}
    for policy_id, current, version in bind.execute(sa.text("SELECT id, monitors, version FROM monitoring_policies")).fetchall():
        if isinstance(current, str):
            current = json.loads(current)
        kept = [m for m in (current or []) if m.get("metric") not in new_metrics]
        for m in kept:
            m.pop("target", None)
        if kept != list(current or []):
            bind.execute(
                sa.text("UPDATE monitoring_policies SET monitors = :m, version = :v WHERE id = :id"),
                {"m": json.dumps(kept), "v": (version or 0) + 1, "id": policy_id},
            )
