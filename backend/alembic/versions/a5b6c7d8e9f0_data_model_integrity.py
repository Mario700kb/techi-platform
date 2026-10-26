"""Data model integrity: FK indexes, CHECK rules, timestamptz, jsonb inventory, device lifecycle

Revision ID: a5b6c7d8e9f0
Revises: z4a5b6c7d8e9

PostgreSQL only (SQLite tests build the schema from the models).

1. Indexes on the ten foreign keys that had none (deletes and filters by
   group, client or team scanned the whole child table).
2. CHECK rules on configuration and bookkeeping columns (never on telemetry:
   one bad reading would reject a whole upload). Added NOT VALID, then
   validated, so existing rows are checked without a long lock.
3. Every `timestamp` column becomes `timestamptz`, read as UTC. With the
   session in UTC, PostgreSQL 12+ changes only the catalog: no table rewrite,
   no index rebuild, so each lock is brief. telemetry_samples.ts stays: a
   partition key cannot change type. The code reads them as naive UTC as
   before (app.db.session.naive_utc_timestamps).
4. The inventory lists become jsonb, with a GIN index on installed software.
5. devices.lifecycle_state: active / archived / trashed, kept by the database.

The CHECK list is a copy of app.models.constraints as of this revision.
"""
import sqlalchemy as sa
from alembic import op

revision = "a5b6c7d8e9f0"
down_revision = "z4a5b6c7d8e9"
branch_labels = None
depends_on = None

FK_INDEXES = [
    ("agent_command_batches", "created_by"),
    ("device_groups", "client_id"),
    ("devices", "group_id"),
    ("team_client_access", "client_id"),
    ("team_device_access", "device_id"),
    ("team_group_access", "group_id"),
    ("terminal_sessions", "operator_id"),
    ("reenrollment_requests", "new_device_id"),
    ("alert_duty_shifts", "operator_id"),
    ("alert_duty_shifts", "backup_operator_id"),
]

CHECKS = {
    "devices": {
        "ck_devices_trash_is_archived": "deleted_at IS NULL OR is_archived",
        "ck_devices_archived_at": "is_archived = (archived_at IS NOT NULL)",
        "ck_devices_connect_port": "connect_port BETWEEN 1 AND 65535",
        "ck_devices_duplicate_score": "duplicate_score BETWEEN 0 AND 1",
        "ck_devices_counts": "enrollment_count >= 0 AND rustdesk_repair_count >= 0",
    },
    "monitoring_policies": {
        "ck_monitoring_policies_sample_seconds": "sample_seconds BETWEEN 10 AND 3600",
        "ck_monitoring_policies_upload_seconds": "upload_seconds BETWEEN 60 AND 3600",
        "ck_monitoring_policies_buffer_mb": "buffer_mb > 0",
        "ck_monitoring_policies_keep_days": "keep_days > 0",
    },
    "automation_tasks": {
        "ck_automation_tasks_max_failure_percent": "max_failure_percent BETWEEN 0 AND 100",
        "ck_automation_tasks_wave_wait_minutes": "wave_wait_minutes >= 0",
        "ck_automation_tasks_window_minutes": "window_minutes > 0",
    },
    "notification_rules": {"ck_notification_rules_cooldown_seconds": "cooldown_seconds >= 0"},
    "notification_deliveries": {"ck_notification_deliveries_attempt_count": "attempt_count >= 0"},
    "report_schedules": {"ck_report_schedules_period_days": "period_days BETWEEN 1 AND 366"},
    "report_runs": {"ck_report_runs_size_bytes": "size_bytes >= 0"},
    "agent_command_batches": {"ck_agent_command_batches_timeout_seconds": "timeout_seconds > 0"},
    "remote_actions": {"ck_remote_actions_execution_timeout_seconds": "execution_timeout_seconds > 0"},
    "device_alerts": {"ck_device_alerts_sla_paused_minutes": "sla_paused_minutes >= 0"},
    "enrollment_tokens": {"ck_enrollment_tokens_use_count": "use_count >= 0"},
    "revoked_agents": {"ck_revoked_agents_attempt_count": "attempt_count >= 0"},
}

INVENTORY_JSON = ["processes_json", "services_json", "software_json", "patch_json", "security_json", "health_json"]

LIFECYCLE_STATE_SQL = "CASE WHEN deleted_at IS NOT NULL THEN 'trashed' WHEN is_archived THEN 'archived' ELSE 'active' END"


def _timestamp_columns(bind, data_type):
    rows = bind.execute(sa.text(
        "SELECT c.table_name, c.column_name FROM information_schema.columns c "
        "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
        "WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type = :type "
        "AND c.table_name NOT LIKE 'telemetry\\_samples%' ORDER BY 1, 2"
    ), {"type": data_type}).fetchall()
    by_table = {}
    for table, column in rows:
        by_table.setdefault(table, []).append(column)
    return by_table


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    # Brief catalog locks only; give up rather than queue behind the app.
    op.execute("SET LOCAL lock_timeout = '10s'")
    op.execute("SET LOCAL timezone = 'UTC'")

    for table, column in FK_INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_{table}_{column} ON {table} ({column})")

    for table, checks in CHECKS.items():
        for name, expression in checks.items():
            op.execute(
                f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{name}') THEN "
                f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expression}) NOT VALID; END IF; END $$"
            )
            op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")

    for table, columns in _timestamp_columns(bind, "timestamp without time zone").items():
        clauses = ", ".join(f'ALTER COLUMN "{c}" TYPE timestamptz' for c in columns)
        op.execute(f'ALTER TABLE "{table}" {clauses}')

    clauses = ", ".join(f"ALTER COLUMN {c} TYPE jsonb USING {c}::jsonb" for c in INVENTORY_JSON)
    op.execute(f"ALTER TABLE device_inventory {clauses}")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_device_inventory_software_gin "
        "ON device_inventory USING gin (software_json jsonb_path_ops)"
    )

    op.execute(
        "ALTER TABLE devices ADD COLUMN IF NOT EXISTS lifecycle_state varchar(16) "
        f"GENERATED ALWAYS AS ({LIFECYCLE_STATE_SQL}) STORED"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_devices_lifecycle_state ON devices (lifecycle_state)")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute("SET LOCAL timezone = 'UTC'")
    op.execute("DROP INDEX IF EXISTS ix_devices_lifecycle_state")
    op.execute("ALTER TABLE devices DROP COLUMN IF EXISTS lifecycle_state")
    op.execute("DROP INDEX IF EXISTS ix_device_inventory_software_gin")
    clauses = ", ".join(f"ALTER COLUMN {c} TYPE text USING {c}::text" for c in INVENTORY_JSON)
    op.execute(f"ALTER TABLE device_inventory {clauses}")
    # agent_command_batches.created_at was timestamptz before this revision.
    for table, columns in _timestamp_columns(bind, "timestamp with time zone").items():
        columns = [c for c in columns if (table, c) != ("agent_command_batches", "created_at")]
        if columns:
            clauses = ", ".join(f'ALTER COLUMN "{c}" TYPE timestamp' for c in columns)
            op.execute(f'ALTER TABLE "{table}" {clauses}')
    for table, checks in CHECKS.items():
        for name in checks:
            op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
    for table, column in FK_INDEXES:
        if (table, column) != ("terminal_sessions", "operator_id"):
            op.execute(f"DROP INDEX IF EXISTS ix_{table}_{column}")
