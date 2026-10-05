"""Report schedules run on Tirana time: hour_utc -> hour_local.

Each existing schedule is converted from its own next_run_at, so its next run
happens at exactly the same instant as before; from then on the hour follows
Tirana wall-clock time across summer/winter time.

Revision ID: e1f2a3b4c5d6
Revises: d8e4f6a1b2c3
"""

from datetime import timezone
from zoneinfo import ZoneInfo

from alembic import op
import sqlalchemy as sa


revision = "e1f2a3b4c5d6"
down_revision = "d8e4f6a1b2c3"
branch_labels = None
depends_on = None

TIRANA = ZoneInfo("Europe/Tirane")


_schedules = sa.table(
    "report_schedules",
    sa.column("id", sa.Integer),
    sa.column("cadence", sa.String),
    sa.column("next_run_at", sa.DateTime),
)


def _rows(bind):
    # Typed select so next_run_at is a datetime on every backend (naive UTC).
    return bind.execute(sa.select(_schedules.c.id, _schedules.c.cadence, _schedules.c.next_run_at)).fetchall()


def upgrade():
    with op.batch_alter_table("report_schedules") as batch:
        batch.alter_column("hour_utc", new_column_name="hour_local",
                           existing_type=sa.Integer(), existing_nullable=False)

    bind = op.get_bind()
    for row in _rows(bind):
        local = row.next_run_at.replace(tzinfo=timezone.utc).astimezone(TIRANA)
        values = {"id": row.id, "hour": local.hour}
        sql = "UPDATE report_schedules SET hour_local = :hour"
        if row.cadence == "weekly":
            sql += ", day_of_week = :dow"
            values["dow"] = local.weekday()
        elif row.cadence == "monthly":
            sql += ", day_of_month = :dom"
            values["dom"] = min(local.day, 28)
        bind.execute(sa.text(sql + " WHERE id = :id"), values)


def downgrade():
    bind = op.get_bind()
    for row in _rows(bind):
        utc = row.next_run_at
        values = {"id": row.id, "hour": utc.hour}
        sql = "UPDATE report_schedules SET hour_local = :hour"
        if row.cadence == "weekly":
            sql += ", day_of_week = :dow"
            values["dow"] = utc.weekday()
        elif row.cadence == "monthly":
            sql += ", day_of_month = :dom"
            values["dom"] = min(utc.day, 28)
        bind.execute(sa.text(sql + " WHERE id = :id"), values)

    with op.batch_alter_table("report_schedules") as batch:
        batch.alter_column("hour_local", new_column_name="hour_utc",
                           existing_type=sa.Integer(), existing_nullable=False)
