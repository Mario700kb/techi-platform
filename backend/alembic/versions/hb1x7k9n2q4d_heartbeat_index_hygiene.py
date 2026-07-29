"""device_heartbeats index hygiene: add (device_id, created_at DESC), drop 3 unused

Measured on production 2026-07-29 (1,679,402 rows / 1023 MB):

  ix_device_heartbeats_id                       45 MB   2,366,196 scans
  ix_device_heartbeats_created_at               45 MB         235 scans
  device_heartbeats_pkey                        45 MB           3 scans
  ix_device_heartbeats_windows_product_type     23 MB           0 scans  <- dropped
  ix_device_heartbeats_rustdesk_status          23 MB          50 scans
  ix_device_heartbeats_rustdesk_install_status  22 MB           0 scans  <- dropped
  ix_device_heartbeats_rustdesk_id              22 MB           0 scans  <- dropped
  ix_device_heartbeats_device_id                22 MB         260 scans

1) get_recent_by_device() (device_heartbeat_repository.py:22-27) filters
   device_id and orders created_at DESC. With only single-column indexes that
   is a bitmap scan + sort over ~2,170 rows per device. device_telemetry got
   the same composite in x5y6z7a8b9c0; device_heartbeats was left out.

2) The three zero-scan indexes cost 67 MB and are re-written on every insert —
   ~181k heartbeat inserts/day paying for index maintenance nothing reads.

NOT touched here: ix_device_heartbeats_id, which duplicates
device_heartbeats_pkey (both btree on id). It looks redundant but the planner
has chosen it over the pkey (2.37M vs 3 scans), so dropping it shifts real
traffic onto the pkey. That is expected to be harmless, but it is a behavioural
change rather than dead-weight removal and belongs in its own reviewed change.

CONCURRENTLY throughout: device_heartbeats takes ~181k inserts/day and must
never be locked by a migration.

Revision ID: hb1x7k9n2q4d
Revises: e6f7a8b9c0d1
Create Date: 2026-07-29 00:00:00.000000
"""
from alembic import op
from sqlalchemy import text

revision = "hb1x7k9n2q4d"
down_revision = "e6f7a8b9c0d1"
branch_labels = None
depends_on = None

_COMPOSITE = "ix_device_heartbeats_device_id_created_at"

# (index name, column) — verified idx_scan = 0 on production 2026-07-29.
_UNUSED = [
    ("ix_device_heartbeats_windows_product_type", "windows_product_type"),
    ("ix_device_heartbeats_rustdesk_install_status", "rustdesk_install_status"),
    ("ix_device_heartbeats_rustdesk_id", "rustdesk_id"),
]


def upgrade() -> None:
    bind = op.get_bind()

    if bind.dialect.name != "postgresql":
        op.create_index(
            _COMPOSITE, "device_heartbeats", ["device_id", "created_at"], if_not_exists=True
        )
        for name, _column in _UNUSED:
            op.drop_index(name, table_name="device_heartbeats", if_exists=True)
        return

    # CONCURRENTLY must run outside any transaction block.
    # autocommit_block() is the Alembic-native way to achieve this
    # (same pattern as x5y6z7a8b9c0).
    with op.get_context().autocommit_block():
        op.execute(text(
            f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_COMPOSITE} "
            "ON device_heartbeats (device_id, created_at DESC)"
        ))
        for name, _column in _UNUSED:
            op.execute(text(f"DROP INDEX CONCURRENTLY IF EXISTS {name}"))


def downgrade() -> None:
    bind = op.get_bind()

    if bind.dialect.name != "postgresql":
        for name, column in _UNUSED:
            op.create_index(name, "device_heartbeats", [column], if_not_exists=True)
        op.drop_index(_COMPOSITE, table_name="device_heartbeats", if_exists=True)
        return

    with op.get_context().autocommit_block():
        for name, column in _UNUSED:
            op.execute(text(
                f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} "
                f"ON device_heartbeats ({column})"
            ))
        op.execute(text(f"DROP INDEX CONCURRENTLY IF EXISTS {_COMPOSITE}"))
