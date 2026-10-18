"""Device security posture (agent 2.1.31)

Revision ID: q5r6s7t8u9v0
Revises: p4q5r6s7t8u9
Create Date: 2026-10-17 21:30:00.000000

The Windows agent reports antivirus, firewall, BitLocker, UAC, Secure Boot and
local administrators every six hours; the last good snapshot is kept beside
the rest of the device inventory.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "q5r6s7t8u9v0"
down_revision: Union[str, None] = "p4q5r6s7t8u9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns() -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns("device_inventory")}


def upgrade() -> None:
    existing = _columns()
    if "security_json" not in existing:
        op.add_column("device_inventory", sa.Column("security_json", sa.Text(), nullable=True))
    if "security_collected_at" not in existing:
        op.add_column("device_inventory", sa.Column("security_collected_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    existing = _columns()
    if "security_collected_at" in existing:
        op.drop_column("device_inventory", "security_collected_at")
    if "security_json" in existing:
        op.drop_column("device_inventory", "security_json")
