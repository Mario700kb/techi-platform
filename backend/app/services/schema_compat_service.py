import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from app.core.config import settings

logger = logging.getLogger(__name__)


DEVICE_COLUMNS = {
    "agent_id": "VARCHAR(80)",
    "last_enrollment_at": "DATETIME",
    "enrollment_count": "INTEGER NOT NULL DEFAULT 0",
    "reenrolled_from_agent_id": "VARCHAR(80)",
    "os_caption": "VARCHAR(160)",
    "os_build": "VARCHAR(80)",
    "windows_product_type": "INTEGER",
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
    "is_internal": "BOOLEAN NOT NULL DEFAULT 0",
    "internal_kind": "VARCHAR(32)",
}

DEV_TABLES = {
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
            is_active BOOLEAN NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
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
