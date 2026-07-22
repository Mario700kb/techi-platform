"""add reporting engine tables

Revision ID: c7d8e9f0a1b2
Revises: b2c3d4e5f8a9
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "c7d8e9f0a1b2"
down_revision = "b2c3d4e5f8a9"
branch_labels = None
depends_on = None


def upgrade():
    inspector = inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "report_schedules" not in tables:
        op.create_table(
            "report_schedules",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("name", sa.String(160), nullable=False),
            sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
            sa.Column("report_format", sa.String(8), nullable=False),
            sa.Column("cadence", sa.String(16), nullable=False),
            sa.Column("period_days", sa.Integer(), nullable=False, server_default="30"),
            sa.Column("hour_utc", sa.Integer(), nullable=False, server_default="6"),
            sa.Column("day_of_week", sa.Integer(), nullable=True),
            sa.Column("day_of_month", sa.Integer(), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("next_run_at", sa.DateTime(), nullable=False),
            sa.Column("last_run_at", sa.DateTime(), nullable=True),
            sa.Column("created_by", sa.String(128), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )
    schedule_indexes = {index["name"] for index in inspector.get_indexes("report_schedules")}
    if "ix_report_schedules_client_id" not in schedule_indexes:
        op.create_index("ix_report_schedules_client_id", "report_schedules", ["client_id"])
    if "ix_report_schedules_enabled" not in schedule_indexes:
        op.create_index("ix_report_schedules_enabled", "report_schedules", ["enabled"])
    if "ix_report_schedules_next_run_at" not in schedule_indexes:
        op.create_index("ix_report_schedules_next_run_at", "report_schedules", ["next_run_at"])
    if "report_runs" not in tables:
        op.create_table(
            "report_runs",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("schedule_id", sa.Integer(), sa.ForeignKey("report_schedules.id", ondelete="SET NULL"), nullable=True),
            sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
            sa.Column("client_name", sa.String(160), nullable=False),
            sa.Column("report_format", sa.String(8), nullable=False),
            sa.Column("period_start", sa.DateTime(), nullable=False),
            sa.Column("period_end", sa.DateTime(), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
            sa.Column("filename", sa.String(255), nullable=True),
            sa.Column("storage_path", sa.Text(), nullable=True),
            sa.Column("size_bytes", sa.Integer(), nullable=True),
            sa.Column("error_message", sa.String(1024), nullable=True),
            sa.Column("generated_by", sa.String(128), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
        )
    run_indexes = {index["name"] for index in inspector.get_indexes("report_runs")}
    if "ix_report_runs_schedule_id" not in run_indexes:
        op.create_index("ix_report_runs_schedule_id", "report_runs", ["schedule_id"])
    if "ix_report_runs_client_id" not in run_indexes:
        op.create_index("ix_report_runs_client_id", "report_runs", ["client_id"])
    if "ix_report_runs_status" not in run_indexes:
        op.create_index("ix_report_runs_status", "report_runs", ["status"])
    if "ix_report_runs_created_at" not in run_indexes:
        op.create_index("ix_report_runs_created_at", "report_runs", ["created_at"])


def downgrade():
    op.drop_table("report_runs")
    op.drop_table("report_schedules")
