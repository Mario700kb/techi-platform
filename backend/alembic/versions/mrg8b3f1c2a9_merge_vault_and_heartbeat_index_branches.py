"""merge the vault and heartbeat-index branches into a single head

RISK-DB-001. The history forked at z1a2b3c4d5e6 into two branches that were
developed and shipped in parallel:

  z1a2b3c4d5e6 (branchpoint)
   |
   +-- a1b2c3d4e5f7  device agent_sha256
   |   b2c3d4e5f8a9  device_heartbeats.created_at index
   |   c7d8e9f0a1b2  reporting engine tables
   |   d8e9f0a1b2c3  enterprise vault                        <- head 1
   |
   +-- a2b3c4d5e6f7  enrollment audit
       b3c4d5e6f7a8  agent_command_batches
       c4d5e6f7a8b9  device agent_version
       d5e6f7a8b9c0  device display name
       e6f7a8b9c0d1  trusted domain client mapping
       hb1x7k9n2q4d  device_heartbeats index hygiene         <- head 2

Both branches are fully applied in production — `alembic_version` holds two
rows, one per head — so nothing is pending on either side and the two touch
disjoint objects apart from device_heartbeats indexes, which are coherent in
the live schema.

The problem was never a broken schema; it was that `alembic upgrade head` had
no single answer. Any new migration would have had to pick a parent, and a
mistake there is the kind that is only discovered when a deploy applies half a
branch. This collapses the fork so the next feature migration has exactly one
place to attach.

This revision is intentionally EMPTY. It performs no DDL. Its only effect is
bookkeeping: the two rows in `alembic_version` are replaced by one. Running it
against an environment where both parents are already present — which is every
environment — changes no table, no column and no index.

Revision ID: mrg8b3f1c2a9
Revises: d8e9f0a1b2c3, hb1x7k9n2q4d
Create Date: 2026-08-03 00:00:00.000000
"""

revision = "mrg8b3f1c2a9"
down_revision = ("d8e9f0a1b2c3", "hb1x7k9n2q4d")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """No-op. Both parents are already applied wherever this runs."""


def downgrade() -> None:
    """No-op. Downgrading re-opens the fork; the schema is untouched either way."""
