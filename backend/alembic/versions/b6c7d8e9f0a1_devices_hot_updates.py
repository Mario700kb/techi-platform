"""Heartbeats update devices without touching its indexes (HOT updates)

Revision ID: b6c7d8e9f0a1
Revises: a5b6c7d8e9f0

Every heartbeat sets devices.last_seen. Two indexes held last_seen
(ix_devices_last_seen, ix_devices_status_last_seen), so each of those ~1.4
million updates wrote a new row version into all 14 indexes; the table had
been autovacuumed 86,798 times. Both indexes were used 18 and 34 times in
total: with ~950 rows a scan of the whole table costs ~0.3 ms.

- Drop the two last_seen indexes: a last_seen update no longer changes an
  indexed column, so PostgreSQL can update the row in place (HOT).
- fillfactor 80 leaves room on each page for those in-place versions, and
  VACUUM FULL (2.4 MB, under a second) rewrites the pages with that room.
  Best effort: if the lock is not free in 5 s the pages gain room over time.

No code change: the models never declared these indexes.
"""
from alembic import op

revision = "b6c7d8e9f0a1"
down_revision = "a5b6c7d8e9f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DROP INDEX IF EXISTS ix_devices_last_seen")
    op.execute("DROP INDEX IF EXISTS ix_devices_status_last_seen")
    op.execute("ALTER TABLE devices SET (fillfactor = 80)")
    with op.get_context().autocommit_block():
        op.execute("SET lock_timeout = '5s'")
        try:
            op.execute("VACUUM (FULL, ANALYZE) devices")
        except Exception:  # noqa: BLE001 — the room comes with later updates instead
            pass
        op.execute("RESET lock_timeout")


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE devices RESET (fillfactor)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_devices_last_seen ON devices (last_seen)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_devices_status_last_seen ON devices (status, last_seen)")
