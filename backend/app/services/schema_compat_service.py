import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from app.core.config import settings

logger = logging.getLogger(__name__)


DEVICE_COLUMNS = {
    "agent_id": "VARCHAR(80)",
    # Platform Expansion Phase 1 (PLATFORM-EXPANSION-AUDIT.md §8)
    "fqdn": "VARCHAR(255)",
    "kernel_version": "VARCHAR(120)",
    "architecture": "VARCHAR(40)",
    "mac_address": "VARCHAR(64)",
    "timezone": "VARCHAR(64)",
    "last_boot_at": "DATETIME",
    "capabilities": "TEXT",
    "last_enrollment_at": "DATETIME",
    "enrollment_count": "INTEGER NOT NULL DEFAULT 0",
    "reenrolled_from_agent_id": "VARCHAR(80)",
    "os_caption": "VARCHAR(160)",
    "os_build": "VARCHAR(80)",
    "windows_product_type": "INTEGER",
    "display_name": "VARCHAR(128)",
    "rustdesk_install_status": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
    "rustdesk_status": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
    "rustdesk_version": "VARCHAR(80)",
    "rustdesk_install_path": "VARCHAR(512)",
    "rustdesk_last_seen_at": "DATETIME",
    "rustdesk_synced_at": "DATETIME",
    "rustdesk_sync_state": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
    "rustdesk_sync_message": "VARCHAR(255)",
    "rustdesk_verified_at": "DATETIME",
    "rustdesk_manual_override": "BOOLEAN NOT NULL DEFAULT 0",
    "rustdesk_conflict_detected": "BOOLEAN NOT NULL DEFAULT 0",
    "rustdesk_last_repair_at": "DATETIME",
    "rustdesk_repair_count": "INTEGER NOT NULL DEFAULT 0",
    "is_archived": "BOOLEAN NOT NULL DEFAULT 0",
    "archived_at": "DATETIME",
    "archived_by": "VARCHAR(128)",
    "agent_sha256": "VARCHAR(64)",
    "remote_support_password_ciphertext": "TEXT",
    "remote_support_password_wrapped_dek": "TEXT",
    "remote_support_password_updated_at": "DATETIME",
    "remote_support_password_source": "VARCHAR(16)",
    "agent_auth_secret_ciphertext": "TEXT",
    "agent_auth_secret_wrapped_dek": "TEXT",
    "agent_auth_key_hash": "VARCHAR(64)",
    "agent_auth_issued_at": "DATETIME",
    "agent_auth_revoked_at": "DATETIME",
    "agent_auth_last_timestamp_ms": "BIGINT",
    "agent_auth_last_nonce": "VARCHAR(64)",
    "remote_support_active_generation": "INTEGER NOT NULL DEFAULT 0",
    "remote_support_desired_generation": "INTEGER NOT NULL DEFAULT 0",
    "remote_support_desired_password_ciphertext": "TEXT",
    "remote_support_desired_password_wrapped_dek": "TEXT",
    "remote_support_desired_source": "VARCHAR(16)",
    "remote_support_desired_created_at": "DATETIME",
    "remote_support_verification_key_ciphertext": "TEXT",
    "remote_support_verification_key_wrapped_dek": "TEXT",
    "remote_support_expected_fingerprint": "VARCHAR(64)",
    "remote_support_applied_generation": "INTEGER NOT NULL DEFAULT 0",
    "remote_support_applied_at": "DATETIME",
    "remote_support_applied_fingerprint": "VARCHAR(64)",
    "remote_support_apply_status": "VARCHAR(32) NOT NULL DEFAULT 'unsupported_legacy'",
    "heartbeat_auth_state": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
    "heartbeat_auth_state_changed_at": "TIMESTAMP",
    "remote_support_trusted_state": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
    "remote_support_state_trusted_at": "TIMESTAMP",
    "remote_support_state_reason": "VARCHAR(64)",
    "remote_support_failure_reason": "VARCHAR(255)",
    "rustdesk_repair_attempt_count": "INTEGER NOT NULL DEFAULT 0",
    "rustdesk_repair_success_count": "INTEGER NOT NULL DEFAULT 0",
    "rustdesk_consecutive_repair_failures": "INTEGER NOT NULL DEFAULT 0",
    "rustdesk_last_repair_reason": "VARCHAR(255)",
}

HEARTBEAT_COLUMNS = {
    "os_caption": "VARCHAR(160)",
    "os_build": "VARCHAR(80)",
    "windows_product_type": "INTEGER",
    "rustdesk_install_status": "VARCHAR(32)",
    "rustdesk_status": "VARCHAR(32)",
    "rustdesk_version": "VARCHAR(80)",
    "rustdesk_install_path": "VARCHAR(512)",
}

INVENTORY_COLUMNS = {
    "software_json": "TEXT",
    "patch_json": "TEXT",
}

OPERATOR_COLUMNS = {
    "role": "VARCHAR(32) NOT NULL DEFAULT 'readonly'",
    "display_name": "VARCHAR(255)",
    "last_login_at": "DATETIME",
}

REMOTE_ACTION_COLUMNS = {
    "started_at": "DATETIME",
    "cancelled_at": "DATETIME",
    "expired_at": "DATETIME",
    "output": "TEXT",
    "stderr_output": "TEXT",
}

ENROLLMENT_TOKEN_COLUMNS = {
    "is_default": "BOOLEAN NOT NULL DEFAULT 0",
    "token_prefix": "VARCHAR(12)",
    "token_ciphertext": "TEXT",
    "is_internal": "BOOLEAN NOT NULL DEFAULT 0",
    "internal_kind": "VARCHAR(32)",
}

TRUSTED_DOMAIN_COLUMNS = {
    "client_id": "INTEGER",
}

VAULT_CREDENTIAL_COLUMNS = {
    "purpose": "VARCHAR(64)",
    "status": "VARCHAR(16) NOT NULL DEFAULT 'active'",
    "expires_at": "DATETIME",
    "rotation_due_at": "DATETIME",
    "last_tested_at": "DATETIME",
    "last_test_status": "VARCHAR(16)",
    "metadata_json": "TEXT",
}

# Embedded SSH Connect (additive, on top of the Phase 5 terminal_sessions table)
TERMINAL_SESSION_COLUMNS = {
    "mode": "VARCHAR(16) NOT NULL DEFAULT 'agent'",
    "vault_credential_id": "INTEGER",
    "ssh_username": "VARCHAR(160)",
    "credential_source": "VARCHAR(16)",
}

DEV_TABLES = {
    "operator_connect_preferences": """
        CREATE TABLE IF NOT EXISTS operator_connect_preferences (
            id INTEGER PRIMARY KEY,
            operator_id INTEGER NOT NULL,
            platform VARCHAR(32) NOT NULL,
            device_id INTEGER,
            method_id VARCHAR(32) NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            UNIQUE(operator_id, platform, device_id)
        )
    """,
    "terminal_sessions": """
        CREATE TABLE IF NOT EXISTS terminal_sessions (
            id VARCHAR(64) PRIMARY KEY,
            device_id INTEGER NOT NULL,
            operator_id INTEGER,
            operator_username VARCHAR(128),
            status VARCHAR(16) NOT NULL DEFAULT 'pending',
            engine VARCHAR(24) NOT NULL DEFAULT 'bash',
            operator_ticket_hash VARCHAR(64) NOT NULL,
            agent_ticket_hash VARCHAR(64) NOT NULL,
            created_at DATETIME NOT NULL,
            expires_at DATETIME NOT NULL,
            started_at DATETIME,
            ended_at DATETIME,
            disconnect_reason VARCHAR(64),
            recording_path VARCHAR(512),
            mode VARCHAR(16) NOT NULL DEFAULT 'agent',
            vault_credential_id INTEGER,
            ssh_username VARCHAR(160),
            credential_source VARCHAR(16)
        )
    """,
    "vault_credentials": """
        CREATE TABLE IF NOT EXISTS vault_credentials (
            id INTEGER PRIMARY KEY,
            name VARCHAR(160) NOT NULL,
            credential_type VARCHAR(32) NOT NULL,
            scope_type VARCHAR(16) NOT NULL DEFAULT 'global',
            client_id INTEGER,
            group_id INTEGER,
            device_id INTEGER,
            username VARCHAR(160),
            ciphertext TEXT NOT NULL,
            dek_wrapped TEXT NOT NULL,
            notes VARCHAR(500),
            created_by VARCHAR(128),
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            rotated_at DATETIME,
            last_used_at DATETIME,
            purpose VARCHAR(64),
            status VARCHAR(16) NOT NULL DEFAULT 'active',
            expires_at DATETIME,
            rotation_due_at DATETIME,
            last_tested_at DATETIME,
            last_test_status VARCHAR(16),
            metadata_json TEXT
        )
    """,
    "vault_credential_usage": """
        CREATE TABLE IF NOT EXISTS vault_credential_usage (
            id INTEGER PRIMARY KEY,
            credential_id INTEGER NOT NULL,
            operator_username VARCHAR(128),
            device_id INTEGER,
            action VARCHAR(24) NOT NULL,
            reason VARCHAR(300),
            created_at DATETIME NOT NULL
        )
    """,
    "vault_credential_assignments": """
        CREATE TABLE IF NOT EXISTS vault_credential_assignments (
            id INTEGER PRIMARY KEY,
            credential_id INTEGER NOT NULL,
            client_id INTEGER,
            device_id INTEGER,
            created_by VARCHAR(128),
            created_at DATETIME NOT NULL
        )
    """,
    "audit_logs": """
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY,
            operator_id INTEGER,
            operator_username VARCHAR(128),
            action VARCHAR(64) NOT NULL,
            entity_type VARCHAR(64),
            entity_id INTEGER,
            details_json TEXT,
            created_at DATETIME NOT NULL
        )
    """,
    "operator_scopes": """
        CREATE TABLE IF NOT EXISTS operator_scopes (
            id INTEGER PRIMARY KEY,
            operator_id INTEGER NOT NULL,
            scope_type VARCHAR(16) NOT NULL,
            scope_id INTEGER NOT NULL,
            created_at DATETIME NOT NULL,
            FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE,
            UNIQUE(operator_id, scope_type, scope_id)
        )
    """,
    "device_notes": """
        CREATE TABLE IF NOT EXISTS device_notes (
            id INTEGER PRIMARY KEY,
            device_id INTEGER NOT NULL,
            note TEXT NOT NULL,
            created_by VARCHAR(128),
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
        )
    """,
    "device_activity_events": """
        CREATE TABLE IF NOT EXISTS device_activity_events (
            id INTEGER PRIMARY KEY,
            device_id INTEGER NOT NULL,
            event_type VARCHAR(64) NOT NULL,
            summary VARCHAR(255) NOT NULL,
            detail TEXT,
            actor VARCHAR(128),
            occurred_at DATETIME NOT NULL,
            FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
        )
    """,
    "trusted_domains": """
        CREATE TABLE IF NOT EXISTS trusted_domains (
            id INTEGER PRIMARY KEY,
            domain VARCHAR(255) NOT NULL UNIQUE,
            client_name VARCHAR(160),
            client_id INTEGER,
            is_active BOOLEAN NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """,
    "report_schedules": """
        CREATE TABLE IF NOT EXISTS report_schedules (
            id INTEGER PRIMARY KEY,
            name VARCHAR(160) NOT NULL,
            client_id INTEGER NOT NULL,
            report_format VARCHAR(8) NOT NULL,
            cadence VARCHAR(16) NOT NULL,
            period_days INTEGER NOT NULL DEFAULT 30,
            hour_utc INTEGER NOT NULL DEFAULT 6,
            day_of_week INTEGER,
            day_of_month INTEGER,
            enabled BOOLEAN NOT NULL DEFAULT 1,
            next_run_at DATETIME NOT NULL,
            last_run_at DATETIME,
            created_by VARCHAR(128) NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
        )
    """,
    "report_runs": """
        CREATE TABLE IF NOT EXISTS report_runs (
            id INTEGER PRIMARY KEY,
            schedule_id INTEGER,
            client_id INTEGER NOT NULL,
            client_name VARCHAR(160) NOT NULL,
            report_format VARCHAR(8) NOT NULL,
            period_start DATETIME NOT NULL,
            period_end DATETIME NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'pending',
            filename VARCHAR(255),
            storage_path TEXT,
            size_bytes INTEGER,
            error_message VARCHAR(1024),
            generated_by VARCHAR(128) NOT NULL,
            created_at DATETIME NOT NULL,
            completed_at DATETIME,
            FOREIGN KEY(schedule_id) REFERENCES report_schedules(id) ON DELETE SET NULL,
            FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
        )
    """,
}

DEV_INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_id ON audit_logs (id)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_operator_username ON audit_logs (operator_username)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_action ON audit_logs (action)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_entity_type ON audit_logs (entity_type)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_operator_scopes_id ON operator_scopes (id)",
    "CREATE INDEX IF NOT EXISTS ix_operator_scopes_operator_id ON operator_scopes (operator_id)",
    "CREATE INDEX IF NOT EXISTS ix_device_notes_id ON device_notes (id)",
    "CREATE INDEX IF NOT EXISTS ix_device_notes_device_id ON device_notes (device_id)",
    "CREATE INDEX IF NOT EXISTS ix_device_activity_events_id ON device_activity_events (id)",
    "CREATE INDEX IF NOT EXISTS ix_device_activity_events_device_id ON device_activity_events (device_id)",
    "CREATE INDEX IF NOT EXISTS ix_device_activity_events_event_type ON device_activity_events (event_type)",
    "CREATE INDEX IF NOT EXISTS ix_device_activity_events_occurred_at ON device_activity_events (occurred_at)",
    "CREATE INDEX IF NOT EXISTS ix_trusted_domains_id ON trusted_domains (id)",
    "CREATE INDEX IF NOT EXISTS ix_trusted_domains_domain ON trusted_domains (domain)",
    "CREATE INDEX IF NOT EXISTS ix_trusted_domains_is_active ON trusted_domains (is_active)",
    "CREATE INDEX IF NOT EXISTS ix_trusted_domains_client_id ON trusted_domains (client_id)",
    "CREATE INDEX IF NOT EXISTS ix_report_schedules_client_id ON report_schedules (client_id)",
    "CREATE INDEX IF NOT EXISTS ix_report_schedules_enabled ON report_schedules (enabled)",
    "CREATE INDEX IF NOT EXISTS ix_report_schedules_next_run_at ON report_schedules (next_run_at)",
    "CREATE INDEX IF NOT EXISTS ix_report_runs_schedule_id ON report_runs (schedule_id)",
    "CREATE INDEX IF NOT EXISTS ix_report_runs_client_id ON report_runs (client_id)",
    "CREATE INDEX IF NOT EXISTS ix_report_runs_status ON report_runs (status)",
    "CREATE INDEX IF NOT EXISTS ix_report_runs_created_at ON report_runs (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_vault_credentials_purpose ON vault_credentials (purpose)",
    "CREATE INDEX IF NOT EXISTS ix_vault_credentials_status ON vault_credentials (status)",
    "CREATE INDEX IF NOT EXISTS ix_vault_credential_assignments_credential_id ON vault_credential_assignments (credential_id)",
    "CREATE INDEX IF NOT EXISTS ix_vault_credential_assignments_client_id ON vault_credential_assignments (client_id)",
    "CREATE INDEX IF NOT EXISTS ix_vault_credential_assignments_device_id ON vault_credential_assignments (device_id)",
]


def ensure_sqlite_dev_schema(engine: Engine) -> None:
    if not settings.DATABASE_URL.startswith("sqlite"):
        return

    inspector = inspect(engine)
    for table_name, columns in {
        "devices": DEVICE_COLUMNS,
        "operators": OPERATOR_COLUMNS,
        "device_heartbeats": HEARTBEAT_COLUMNS,
        "device_inventory": INVENTORY_COLUMNS,
        "remote_actions": REMOTE_ACTION_COLUMNS,
        "enrollment_tokens": ENROLLMENT_TOKEN_COLUMNS,
        "trusted_domains": TRUSTED_DOMAIN_COLUMNS,
        "vault_credentials": VAULT_CREDENTIAL_COLUMNS,
        "terminal_sessions": TERMINAL_SESSION_COLUMNS,
    }.items():
        if not inspector.has_table(table_name):
            continue
        existing_columns = {column["name"] for column in inspector.get_columns(table_name)}
        missing_columns = [
            (column_name, definition)
            for column_name, definition in columns.items()
            if column_name not in existing_columns
        ]
        if not missing_columns:
            continue

        with engine.begin() as connection:
            for column_name, definition in missing_columns:
                connection.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"))
                logger.info("Added SQLite dev column %s.%s", table_name, column_name)

    with engine.begin() as connection:
        for table_name, create_sql in DEV_TABLES.items():
            if not inspector.has_table(table_name):
                connection.execute(text(create_sql))
                logger.info("Created SQLite dev table %s", table_name)
        for index_sql in DEV_INDEXES:
            connection.execute(text(index_sql))
