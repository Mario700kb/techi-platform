"""Alert deadlines, escalation steps, waiting, incidents and the duty roster

Revision ID: x2y3z4a5b6c7
Revises: w1x2y3z4a5b6

device_alerts gains its deadlines (when it must be taken and fixed, stamped
once at open), the escalation step it reached and when the next one is due,
work on it (first action, waiting on someone else), the lead alert of an
incident, and the "recurring" mark. One new table: who keeps the queue on
which days. Only nullable columns or columns with a server default, no row
rewritten: open alerts get their deadlines from the first sweep after the
deploy, with the clock starting then, so nothing is overdue at once.
Run alone with PGOPTIONS='-c lock_timeout=5000' (heartbeats hold devices).
"""
import sqlalchemy as sa
from alembic import op

revision = "x2y3z4a5b6c7"
down_revision = "w1x2y3z4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("device_alerts", sa.Column("sla_started_at", sa.DateTime(), nullable=True))
    op.add_column("device_alerts", sa.Column("ack_due_at", sa.DateTime(), nullable=True))
    op.add_column("device_alerts", sa.Column("resolve_due_at", sa.DateTime(), nullable=True))
    op.add_column("device_alerts", sa.Column("sla_24x7", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("device_alerts", sa.Column("sla_paused_minutes", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("device_alerts", sa.Column("sla_step", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("device_alerts", sa.Column("next_check_at", sa.DateTime(), nullable=True))
    op.add_column("device_alerts", sa.Column("first_action_at", sa.DateTime(), nullable=True))
    op.add_column("device_alerts", sa.Column("waiting_reason", sa.String(length=32), nullable=True))
    op.add_column("device_alerts", sa.Column("waiting_since", sa.DateTime(), nullable=True))
    op.add_column("device_alerts", sa.Column("parent_id", sa.Integer(), nullable=True))
    op.add_column("device_alerts", sa.Column("recurring", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index("ix_device_alerts_parent_id", "device_alerts", ["parent_id"])
    op.create_index(
        "ix_device_alerts_open_next_check", "device_alerts", ["next_check_at"],
        postgresql_where=sa.text("state = 'open'"), sqlite_where=sa.text("state = 'open'"),
    )
    with op.batch_alter_table("device_alerts") as batch:
        batch.create_foreign_key(
            "fk_device_alerts_parent_id", "device_alerts", ["parent_id"], ["id"], ondelete="SET NULL"
        )

    op.create_table(
        "alert_duty_shifts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("starts_on", sa.Date(), nullable=False),
        sa.Column("ends_on", sa.Date(), nullable=False),
        sa.Column("operator_id", sa.Integer(), sa.ForeignKey("operators.id", ondelete="CASCADE"), nullable=False),
        sa.Column("backup_operator_id", sa.Integer(), sa.ForeignKey("operators.id", ondelete="SET NULL"), nullable=True),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_alert_duty_shifts_starts_on", "alert_duty_shifts", ["starts_on"])
    op.create_index("ix_alert_duty_shifts_ends_on", "alert_duty_shifts", ["ends_on"])


def downgrade() -> None:
    op.drop_index("ix_alert_duty_shifts_ends_on", table_name="alert_duty_shifts")
    op.drop_index("ix_alert_duty_shifts_starts_on", table_name="alert_duty_shifts")
    op.drop_table("alert_duty_shifts")
    with op.batch_alter_table("device_alerts") as batch:
        batch.drop_constraint("fk_device_alerts_parent_id", type_="foreignkey")
    op.drop_index("ix_device_alerts_open_next_check", table_name="device_alerts")
    op.drop_index("ix_device_alerts_parent_id", table_name="device_alerts")
    for column in ("recurring", "parent_id", "waiting_since", "waiting_reason", "first_action_at", "next_check_at",
                   "sla_step", "sla_paused_minutes", "sla_24x7", "resolve_due_at", "ack_due_at", "sla_started_at"):
        op.drop_column("device_alerts", column)
