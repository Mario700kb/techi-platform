"""GPU use in the telemetry samples and rollups; Linux services in the Servers policy

Revision ID: e4f6a8c0b2d1
Revises: b6c7d8e9f0a1

Agent 2.1.48 adds to each 1-minute sample the busiest GPU engine % and the GPU
memory in use; the rollups keep their average and peak. Nullable REAL with no
default, so adding them rewrites nothing and takes only a brief lock (on
PostgreSQL the partitions of telemetry_samples inherit them).

The same agent watches systemd units on Linux, so the service monitors of the
Servers policies gain the usual Linux server roles. A name a machine does not
have is simply not watched, so Windows servers are unaffected and the other way
round. Only names a list does not hold yet are added, keeping what an operator
wrote, and each policy changed moves to its next version.
"""
import json
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e4f6a8c0b2d1"
down_revision: Union[str, None] = "b6c7d8e9f0a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SAMPLE_COLUMNS = ("gpu", "gpu_mem_mb")
ROLLUP_COLUMNS = ("gpu_avg", "gpu_max", "gpu_mem_avg", "gpu_mem_max")
ROLLUPS = ("telemetry_rollup_5m", "telemetry_rollup_1h")
LINUX_SERVICES = ("ssh", "sshd", "docker", "nginx*", "apache2", "httpd", "postgresql*", "mysql*", "mariadb")
TARGET_LIMIT = 512  # MonitorRule.target


def _set_linux_services(bind, change) -> None:
    rows = bind.execute(sa.text(
        "SELECT id, monitors, version FROM monitoring_policies "
        "WHERE scope = 'device_type' AND scope_value IN ('server', 'servers')"
    )).fetchall()
    policies = sa.table(
        "monitoring_policies",
        sa.column("id", sa.Integer), sa.column("monitors", sa.JSON), sa.column("version", sa.Integer),
        sa.column("updated_at", sa.DateTime), sa.column("updated_by", sa.String),
    )
    for policy_id, monitors, version in rows:
        monitors = json.loads(monitors) if isinstance(monitors, str) else list(monitors or [])
        changed = False
        for monitor in monitors:
            if monitor.get("metric") != "service":
                continue
            names = [n.strip() for n in (monitor.get("target") or "").split(",") if n.strip()]
            updated = ", ".join(change(names))
            if updated != ", ".join(names) and len(updated) <= TARGET_LIMIT:
                monitor["target"], changed = updated, True
        if changed:
            bind.execute(policies.update().where(policies.c.id == policy_id).values(
                monitors=monitors, version=(version or 0) + 1,
                updated_at=datetime.now(timezone.utc).replace(tzinfo=None), updated_by="system",
            ))


def upgrade() -> None:
    for column in SAMPLE_COLUMNS:
        op.add_column("telemetry_samples", sa.Column(column, sa.REAL(), nullable=True))
    for table in ROLLUPS:
        for column in ROLLUP_COLUMNS:
            op.add_column(table, sa.Column(column, sa.REAL(), nullable=True))
    _set_linux_services(op.get_bind(), lambda names: names + [
        n for n in LINUX_SERVICES if n.lower() not in {name.lower() for name in names}
    ])


def downgrade() -> None:
    _set_linux_services(op.get_bind(), lambda names: [n for n in names if n not in LINUX_SERVICES])
    for table in ROLLUPS:
        for column in reversed(ROLLUP_COLUMNS):
            op.drop_column(table, column)
    for column in reversed(SAMPLE_COLUMNS):
        op.drop_column("telemetry_samples", column)
