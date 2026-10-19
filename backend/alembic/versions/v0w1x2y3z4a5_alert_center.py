"""Alert center: work queue, mutes, activity, AI analyses

Revision ID: v0w1x2y3z4a5
Revises: u9v0w1x2y3z4

device_alerts gains what a work queue needs: the fingerprint (which service,
volume or event group inside the device), the occurrence count of a problem
that keeps coming back, its priority, its owner, snooze and how it was
resolved. Three new tables: the alert timeline, mute rules and AI analyses.
Only nullable columns or columns with a server default: no row is rewritten
by hand, and alertkind is not touched (no ALTER TYPE).
"""
import sqlalchemy as sa
from alembic import op

revision = "v0w1x2y3z4a5"
down_revision = "u9v0w1x2y3z4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("device_alerts", sa.Column("fingerprint", sa.String(length=128), nullable=False, server_default=""))
    op.add_column("device_alerts", sa.Column("occurrences", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("device_alerts", sa.Column("last_seen_at", sa.DateTime(), nullable=True))
    op.add_column("device_alerts", sa.Column("priority", sa.Integer(), nullable=True))
    op.add_column("device_alerts", sa.Column("assigned_to_id", sa.Integer(), nullable=True))
    op.add_column("device_alerts", sa.Column("snoozed_until", sa.DateTime(), nullable=True))
    op.add_column(
        "device_alerts",
        sa.Column("snooze_until_worse", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("device_alerts", sa.Column("resolution", sa.String(length=32), nullable=True))
    op.add_column("device_alerts", sa.Column("resolved_by", sa.String(length=128), nullable=True))
    op.add_column("device_alerts", sa.Column("escalated_at", sa.DateTime(), nullable=True))
    op.create_index("ix_device_alerts_priority", "device_alerts", ["priority"])
    op.create_index("ix_device_alerts_assigned_to_id", "device_alerts", ["assigned_to_id"])
    with op.batch_alter_table("device_alerts") as batch:
        batch.create_foreign_key(
            "fk_device_alerts_assigned_to_id", "operators", ["assigned_to_id"], ["id"], ondelete="SET NULL"
        )
    # Open alerts get a priority now; resolved history keeps none.
    op.execute(
        "UPDATE device_alerts SET priority = CASE severity "
        "WHEN 'critical' THEN 2 WHEN 'warning' THEN 3 ELSE 4 END, last_seen_at = updated_at "
        "WHERE state = 'open'"
    )

    op.create_table(
        "alert_activity",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("alert_id", sa.Integer(), sa.ForeignKey("device_alerts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("at", sa.DateTime(), nullable=False),
        sa.Column("actor", sa.String(length=128), nullable=True),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("detail", sa.String(length=1000), nullable=True),
    )
    op.create_index("ix_alert_activity_alert_id", "alert_activity", ["alert_id"])

    op.create_table(
        "alert_mutes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=True),
        sa.Column("kind", sa.String(length=64), nullable=True),
        sa.Column("fingerprint", sa.String(length=128), nullable=True),
        sa.Column("until", sa.DateTime(), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("removed_at", sa.DateTime(), nullable=True),
        sa.Column("removed_by", sa.String(length=128), nullable=True),
    )
    op.create_index("ix_alert_mutes_device_id", "alert_mutes", ["device_id"])
    op.create_index("ix_alert_mutes_client_id", "alert_mutes", ["client_id"])

    op.create_table(
        "alert_analyses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("alert_id", sa.Integer(), sa.ForeignKey("device_alerts.id", ondelete="CASCADE"), nullable=True),
        sa.Column("group_key", sa.String(length=200), nullable=True),
        sa.Column("language", sa.String(length=8), nullable=False, server_default="sq"),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("result_json", sa.Text(), nullable=True),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Float(), nullable=True),
        sa.Column("occurrences", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=True),
        sa.Column("rated_by", sa.String(length=128), nullable=True),
    )
    op.create_index("ix_alert_analyses_alert_id", "alert_analyses", ["alert_id"])
    op.create_index("ix_alert_analyses_group_key", "alert_analyses", ["group_key"])
    op.create_index("ix_alert_analyses_created_at", "alert_analyses", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_alert_analyses_created_at", table_name="alert_analyses")
    op.drop_index("ix_alert_analyses_group_key", table_name="alert_analyses")
    op.drop_index("ix_alert_analyses_alert_id", table_name="alert_analyses")
    op.drop_table("alert_analyses")
    op.drop_index("ix_alert_mutes_client_id", table_name="alert_mutes")
    op.drop_index("ix_alert_mutes_device_id", table_name="alert_mutes")
    op.drop_table("alert_mutes")
    op.drop_index("ix_alert_activity_alert_id", table_name="alert_activity")
    op.drop_table("alert_activity")
    with op.batch_alter_table("device_alerts") as batch:
        batch.drop_constraint("fk_device_alerts_assigned_to_id", type_="foreignkey")
    op.drop_index("ix_device_alerts_assigned_to_id", table_name="device_alerts")
    op.drop_index("ix_device_alerts_priority", table_name="device_alerts")
    for column in (
        "escalated_at", "resolved_by", "resolution", "snooze_until_worse", "snoozed_until",
        "assigned_to_id", "priority", "last_seen_at", "occurrences", "fingerprint",
    ):
        op.drop_column("device_alerts", column)
