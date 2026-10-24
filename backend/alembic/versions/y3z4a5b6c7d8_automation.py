"""Automation: scheduled agent updates in waves

Revision ID: y3z4a5b6c7d8
Revises: x2y3z4a5b6c7

Two new tables, nothing existing touched: automation_tasks (what, for which
devices, when, in which waves) and automation_runs (each run and its waves).
"""
import sqlalchemy as sa
from alembic import op

revision = "y3z4a5b6c7d8"
down_revision = "x2y3z4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "automation_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False, server_default="agent_update"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("scope", sa.String(length=16), nullable=False, server_default="default"),
        sa.Column("scope_value", sa.String(length=64), nullable=True),
        sa.Column("device_ids", sa.JSON(), nullable=True),
        sa.Column("excluded_client_ids", sa.JSON(), nullable=True),
        sa.Column("excluded_device_ids", sa.JSON(), nullable=True),
        sa.Column("skip_maintenance", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("schedule", sa.String(length=16), nullable=False, server_default="once"),
        sa.Column("run_at", sa.DateTime(), nullable=True),
        sa.Column("time_of_day", sa.String(length=5), nullable=True),
        sa.Column("weekday", sa.Integer(), nullable=True),
        sa.Column("day_of_month", sa.Integer(), nullable=True),
        sa.Column("window_minutes", sa.Integer(), nullable=False, server_default="240"),
        sa.Column("wave_sizes", sa.JSON(), nullable=False),
        sa.Column("wave_wait_minutes", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("max_failure_percent", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_automation_tasks_next_run_at", "automation_tasks", ["next_run_at"])
    op.create_table(
        "automation_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("automation_tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="running"),
        sa.Column("trigger", sa.String(length=16), nullable=False, server_default="schedule"),
        sa.Column("started_by", sa.String(length=128), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("next_wave_at", sa.DateTime(), nullable=True),
        sa.Column("waves", sa.JSON(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
    )
    op.create_index("ix_automation_runs_task_id", "automation_runs", ["task_id"])
    op.create_index("ix_automation_runs_status", "automation_runs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_automation_runs_status", table_name="automation_runs")
    op.drop_index("ix_automation_runs_task_id", table_name="automation_runs")
    op.drop_table("automation_runs")
    op.drop_index("ix_automation_tasks_next_run_at", table_name="automation_tasks")
    op.drop_table("automation_tasks")
