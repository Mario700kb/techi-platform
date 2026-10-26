"""Devices show installed RAM, not usable RAM rounded down

Revision ID: z4a5b6c7d8e9
Revises: y3z4a5b6c7d8

Data only. Agents before 2.1.47 sent usable memory rounded down to a whole GB
("3 GB" on a PC with 4 GB installed) and MikroTik sends bytes. The heartbeat
now corrects what arrives (app.services.device_hardware); this corrects what
is stored, so devices that stay offline show the right size too. The rule is
copied here so a later change to the service cannot change this migration.
"""
import re

import sqlalchemy as sa
from alembic import op

revision = "z4a5b6c7d8e9"
down_revision = "y3z4a5b6c7d8"
branch_labels = None
depends_on = None

_WHOLE_GB = re.compile(r"^(\d+) GB$")
_MIB = 1024 ** 2
_GIB = 1024 ** 3


def _label(ram):
    text = ram.strip()
    if text.isdigit():
        size = int(text)
        if size >= _GIB:
            return f"{round(size / _GIB)} GB"
        return f"{round(size / _MIB)} MB" if size >= _MIB else ram
    match = _WHOLE_GB.match(text)
    if not match:
        return ram
    whole = int(match.group(1))
    return f"{whole + 1} GB" if whole >= 1 else "<1 GB"


def _reports_installed(agent_version):
    try:
        return tuple(int(p) for p in (agent_version or "").strip().split(".")) >= (2, 1, 47)
    except ValueError:
        return False


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, ram, agent_version FROM devices WHERE ram IS NOT NULL")).fetchall()
    for device_id, ram, agent_version in rows:
        if _reports_installed(agent_version) and not ram.strip().isdigit():
            continue
        fixed = _label(ram)
        if fixed != ram:
            bind.execute(sa.text("UPDATE devices SET ram = :ram WHERE id = :id"), {"ram": fixed, "id": device_id})


def downgrade() -> None:
    # Nothing to undo: the old values were wrong, and older code shows the new
    # ones as they are.
    pass
