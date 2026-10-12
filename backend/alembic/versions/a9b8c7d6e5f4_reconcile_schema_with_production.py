"""Bring any database to the schema production actually has.

Part of the schema was created outside Alembic over time — the notification,
terminal-session and connect-preference tables, ~30 device columns, the
devices.agent_id unique constraint — and eight redundant indexes were dropped
by hand on 2026-08-03. `alembic upgrade head` on an empty database therefore
built a different schema from production's (144 objects only in production,
16 only in the migrated copy), so a new environment, a CI database or a
rebuild after a disaster could not come from migrations.

Every statement here is conditional (IF NOT EXISTS / IF EXISTS / catalog
checks) and matches production's definitions exactly, so on production this
revision changes nothing; on an empty database it closes the gap. Verified by
diffing columns, indexes and constraints of a fresh `upgrade head` against a
schema-only dump of production. PostgreSQL only — SQLite dev databases are
shaped by schema_compat_service.

Revision ID: a9b8c7d6e5f4
Revises: f2a3b4c5d6e7
"""

from alembic import op

revision = "a9b8c7d6e5f4"
down_revision = "f2a3b4c5d6e7"
branch_labels = None
depends_on = None


DEVICE_COLUMNS = [
    "agent_id character varying(80)",
    "architecture character varying(40)",
    "capabilities jsonb",
    "enrollment_count integer DEFAULT 0 NOT NULL",
    "fqdn character varying(255)",
    "kernel_version character varying(120)",
    "last_boot_at timestamp without time zone",
    "last_enrollment_at timestamp without time zone",
    "mac_address character varying(64)",
    "reenrolled_from_agent_id character varying(80)",
    "remote_support_password_ciphertext text",
    "remote_support_password_source character varying(16)",
    "remote_support_password_updated_at timestamp without time zone",
    "rustdesk_conflict_detected boolean DEFAULT false NOT NULL",
    "rustdesk_install_path character varying(512)",
    "rustdesk_install_status character varying(32) DEFAULT 'unknown' NOT NULL",
    "rustdesk_last_repair_at timestamp without time zone",
    "rustdesk_last_seen_at timestamp without time zone",
    "rustdesk_manual_override boolean DEFAULT false NOT NULL",
    "rustdesk_repair_count integer DEFAULT 0 NOT NULL",
    "rustdesk_status character varying(32) DEFAULT 'unknown' NOT NULL",
    "rustdesk_sync_message character varying(255)",
    "rustdesk_sync_state character varying(32) DEFAULT 'unknown' NOT NULL",
    "rustdesk_synced_at timestamp without time zone",
    "rustdesk_verified_at timestamp without time zone",
    "rustdesk_version character varying(80)",
    "timezone character varying(64)",
]

TABLES = [
    """
    CREATE TABLE IF NOT EXISTS notification_channels (
        id serial PRIMARY KEY,
        name character varying(160) NOT NULL,
        channel_type character varying(24) NOT NULL,
        enabled boolean DEFAULT true NOT NULL,
        config_json text NOT NULL,
        secret_ciphertext text,
        secret_dek_wrapped text,
        created_by character varying(128),
        created_at timestamp without time zone DEFAULT now() NOT NULL,
        updated_at timestamp without time zone DEFAULT now() NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS notification_rules (
        id serial PRIMARY KEY,
        event_type character varying(64) NOT NULL,
        scope_type character varying(16) DEFAULT 'global' NOT NULL,
        client_id integer REFERENCES clients(id),
        channel_id integer NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
        enabled boolean DEFAULT true NOT NULL,
        min_severity character varying(16),
        cooldown_seconds integer DEFAULT 0 NOT NULL,
        rate_limit_per_hour integer,
        created_by character varying(128),
        created_at timestamp without time zone DEFAULT now() NOT NULL,
        updated_at timestamp without time zone DEFAULT now() NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS notification_deliveries (
        id serial PRIMARY KEY,
        rule_id integer REFERENCES notification_rules(id) ON DELETE SET NULL,
        channel_id integer NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
        event_type character varying(64) NOT NULL,
        device_id integer,
        client_id integer,
        title character varying(200) NOT NULL,
        message text NOT NULL,
        payload_json text,
        status character varying(16) DEFAULT 'pending' NOT NULL,
        attempt_count integer DEFAULT 0 NOT NULL,
        last_error character varying(1024),
        created_at timestamp without time zone DEFAULT now() NOT NULL,
        sent_at timestamp without time zone,
        next_retry_at timestamp without time zone
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS operator_connect_preferences (
        id serial PRIMARY KEY,
        operator_id integer NOT NULL REFERENCES operators(id),
        platform character varying(32) NOT NULL,
        device_id integer REFERENCES devices(id),
        method_id character varying(32) NOT NULL,
        created_at timestamp without time zone DEFAULT now() NOT NULL,
        updated_at timestamp without time zone DEFAULT now() NOT NULL,
        CONSTRAINT uq_connect_pref_operator_platform_device UNIQUE (operator_id, platform, device_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS terminal_sessions (
        id character varying(64) PRIMARY KEY,
        device_id integer NOT NULL REFERENCES devices(id),
        operator_id integer REFERENCES operators(id),
        operator_username character varying(128),
        status character varying(16) DEFAULT 'pending' NOT NULL,
        engine character varying(24) DEFAULT 'bash' NOT NULL,
        operator_ticket_hash character varying(64) NOT NULL,
        agent_ticket_hash character varying(64) NOT NULL,
        created_at timestamp without time zone DEFAULT now() NOT NULL,
        expires_at timestamp without time zone NOT NULL,
        started_at timestamp without time zone,
        ended_at timestamp without time zone,
        disconnect_reason character varying(64),
        recording_path character varying(512),
        mode character varying(16) DEFAULT 'agent' NOT NULL,
        vault_credential_id integer,
        ssh_username character varying(160),
        credential_source character varying(16)
    )
    """,
]

INDEXES = [
    "ix_notification_channels_channel_type ON notification_channels (channel_type)",
    "ix_notification_deliveries_channel_id ON notification_deliveries (channel_id)",
    "ix_notification_deliveries_client_id ON notification_deliveries (client_id)",
    "ix_notification_deliveries_created_at ON notification_deliveries (created_at)",
    "ix_notification_deliveries_device_id ON notification_deliveries (device_id)",
    "ix_notification_deliveries_event_type ON notification_deliveries (event_type)",
    "ix_notification_deliveries_next_retry_at ON notification_deliveries (next_retry_at)",
    "ix_notification_deliveries_rule_id ON notification_deliveries (rule_id)",
    "ix_notification_deliveries_status ON notification_deliveries (status)",
    "ix_notification_rules_channel_id ON notification_rules (channel_id)",
    "ix_notification_rules_client_id ON notification_rules (client_id)",
    "ix_notification_rules_event_type ON notification_rules (event_type)",
    "ix_notification_rules_scope_type ON notification_rules (scope_type)",
    "ix_operator_connect_preferences_device_id ON operator_connect_preferences (device_id)",
    "ix_operator_connect_preferences_operator_id ON operator_connect_preferences (operator_id)",
    "ix_operator_connect_preferences_platform ON operator_connect_preferences (platform)",
    "ix_terminal_sessions_device_id ON terminal_sessions (device_id)",
    "ix_terminal_sessions_status ON terminal_sessions (status)",
]

# Dropped by hand in production on 2026-08-03 (DB-INDEX cleanup): each only
# shadowed a primary key or was a prefix of an existing composite index.
REDUNDANT_INDEXES = [
    "ix_device_heartbeats_device_id",
    "ix_device_heartbeats_id",
    "ix_device_heartbeats_rustdesk_status",
    "ix_device_telemetry_device_id",
    "ix_device_telemetry_id",
    "ix_devices_id",
    "ix_devices_rustdesk_id",
]

# Production's lengths, where the migrated copy had others.
VARCHAR_LENGTHS = [
    ("device_heartbeats", "rustdesk_install_path", 255),
    ("device_heartbeats", "rustdesk_install_status", 50),
    ("device_heartbeats", "rustdesk_status", 50),
    ("device_heartbeats", "rustdesk_version", 50),
    ("enrollment_tokens", "internal_kind", 50),
]

NOW_DEFAULTS = [
    ("report_runs", "created_at"),
    ("report_schedules", "created_at"),
    ("report_schedules", "updated_at"),
    ("vault_credential_assignments", "created_at"),
]


def upgrade():
    if op.get_bind().dialect.name != "postgresql":
        return

    for column in DEVICE_COLUMNS:
        op.execute(f"ALTER TABLE devices ADD COLUMN IF NOT EXISTS {column}")
    op.execute(
        """
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'devices'::regclass AND contype = 'u'
                  AND pg_get_constraintdef(oid) = 'UNIQUE (agent_id)'
            ) THEN
                ALTER TABLE devices ADD CONSTRAINT devices_agent_id_key UNIQUE (agent_id);
            END IF;
        END $$
        """
    )

    op.execute("ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS internal_kind character varying(50)")
    for column, kind in (
        ("rustdesk_install_path", "character varying(255)"),
        ("rustdesk_install_status", "character varying(50)"),
        ("rustdesk_status", "character varying(50)"),
        ("rustdesk_version", "character varying(50)"),
    ):
        op.execute(f"ALTER TABLE device_heartbeats ADD COLUMN IF NOT EXISTS {column} {kind}")

    for statement in TABLES:
        op.execute(statement)
    for index in INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS {index}")
    for name in REDUNDANT_INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")

    # Catalog-checked so production, already at these values, takes no lock.
    for table, column, length in VARCHAR_LENGTHS:
        op.execute(
            f"""
            DO $$ BEGIN
                IF (SELECT character_maximum_length FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = '{table}' AND column_name = '{column}')
                   IS DISTINCT FROM {length} THEN
                    ALTER TABLE {table} ALTER COLUMN {column} TYPE character varying({length});
                END IF;
            END $$
            """
        )
    for table, column in NOW_DEFAULTS:
        op.execute(
            f"""
            DO $$ BEGIN
                IF (SELECT column_default FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = '{table}' AND column_name = '{column}') IS NULL THEN
                    ALTER TABLE {table} ALTER COLUMN {column} SET DEFAULT now();
                END IF;
            END $$
            """
        )


def downgrade():
    # Deliberately a no-op: on production these objects predate this revision
    # and hold live data; removing them would be destructive, not a rollback.
    pass
