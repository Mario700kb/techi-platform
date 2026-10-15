"""Drop indexes another index already covers, and a leftover table

Revision ID: j0k1l2m3n4o5
Revises: i9j0k1l2m3n4

The 2026-10-15 database review found 39 non-unique indexes that duplicate a
primary key (`ix_<table>_id`, from `index=True` on primary-key columns), a
unique constraint, or the leading column of a composite index. Each one is
written on every insert — on device_alerts and device_status_history, the
busiest tables, two extra indexes (69 MB in all on the large tables) — and
none answers a query the other index cannot. The models no longer declare
them, so they do not come back.

On PostgreSQL the indexes are dropped CONCURRENTLY, outside a transaction,
so heartbeats and alert writes are never blocked behind the drop.

`device_repair_count_reset_20260702` is a one-off copy made in July (314
rows, no primary key); its data is in the pre-deploy dump.
"""
import sqlalchemy as sa
from alembic import op

revision = "j0k1l2m3n4o5"
down_revision = "i9j0k1l2m3n4"
branch_labels = None
depends_on = None

# (index, table, columns) — what the downgrade recreates.
REDUNDANT = [
    ("ix_audit_logs_id", "audit_logs", ["id"]),
    ("ix_clients_id", "clients", ["id"]),
    ("ix_clients_name", "clients", ["name"]),
    ("ix_device_activity_events_id", "device_activity_events", ["id"]),
    ("ix_device_alerts_device_id", "device_alerts", ["device_id"]),
    ("ix_device_alerts_id", "device_alerts", ["id"]),
    ("ix_device_groups_id", "device_groups", ["id"]),
    ("ix_device_inventory_device_id", "device_inventory", ["device_id"]),
    ("ix_device_inventory_id", "device_inventory", ["id"]),
    ("ix_device_notes_id", "device_notes", ["id"]),
    ("ix_device_status_history_id", "device_status_history", ["id"]),
    ("ix_devices_status", "devices", ["status"]),
    ("ix_enrollment_audit_id", "enrollment_audit", ["id"]),
    ("ix_enrollment_tokens_client_id", "enrollment_tokens", ["client_id"]),
    ("ix_enrollment_tokens_id", "enrollment_tokens", ["id"]),
    ("ix_enrollment_tokens_internal_kind", "enrollment_tokens", ["internal_kind"]),
    ("ix_enrollment_tokens_status", "enrollment_tokens", ["status"]),
    ("ix_operator_connect_preferences_operator_id", "operator_connect_preferences", ["operator_id"]),
    ("ix_operator_scopes_id", "operator_scopes", ["id"]),
    ("ix_operator_scopes_operator_id", "operator_scopes", ["operator_id"]),
    ("ix_operators_email", "operators", ["email"]),
    ("ix_operators_id", "operators", ["id"]),
    ("ix_operators_username", "operators", ["username"]),
    ("ix_remote_actions_id", "remote_actions", ["id"]),
    ("ix_team_client_access_id", "team_client_access", ["id"]),
    ("ix_team_client_access_team_id", "team_client_access", ["team_id"]),
    ("ix_team_device_access_id", "team_device_access", ["id"]),
    ("ix_team_device_access_team_id", "team_device_access", ["team_id"]),
    ("ix_team_group_access_id", "team_group_access", ["id"]),
    ("ix_team_group_access_team_id", "team_group_access", ["team_id"]),
    ("ix_team_members_id", "team_members", ["id"]),
    ("ix_team_members_team_id", "team_members", ["team_id"]),
    ("ix_teams_id", "teams", ["id"]),
    ("ix_trusted_domains_domain", "trusted_domains", ["domain"]),
    ("ix_trusted_domains_id", "trusted_domains", ["id"]),
    ("ix_client_documents_id", "client_documents", ["id"]),
    ("ix_client_locations_id", "client_locations", ["id"]),
    ("ix_client_location_rules_id", "client_location_rules", ["id"]),
]

LEFTOVER_TABLE = "device_repair_count_reset_20260702"


def _postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    if _postgres():
        with op.get_context().autocommit_block():
            for name, _table, _columns in REDUNDANT:
                op.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"'))
    else:
        for name, table, _columns in REDUNDANT:
            op.drop_index(name, table_name=table, if_exists=True)
    op.execute(sa.text(f'DROP TABLE IF EXISTS "{LEFTOVER_TABLE}"'))


def downgrade() -> None:
    # The leftover table is not recreated: its rows are in the pre-deploy dump.
    if _postgres():
        with op.get_context().autocommit_block():
            for name, table, columns in REDUNDANT:
                cols = ", ".join(f'"{c}"' for c in columns)
                op.execute(sa.text(f'CREATE INDEX CONCURRENTLY IF NOT EXISTS "{name}" ON "{table}" ({cols})'))
    else:
        for name, table, columns in REDUNDANT:
            op.create_index(name, table, columns, if_not_exists=True)
