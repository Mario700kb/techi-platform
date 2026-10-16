"""Re-enrollment requests; why a Remote Support connection was closed

Revision ID: l2m3n4o5p6q7
Revises: k1l2m3n4o5p6

An enrollment that matches an existing device without proving it is that
device's agent no longer takes the device over: it is stored here until an
admin decides. remote_support_connections.close_reason tells a close RustDesk
reported from one a newer connection showed was lost. A new empty table and a
nullable column: nothing is rewritten.
"""
import sqlalchemy as sa
from alembic import op

revision = "l2m3n4o5p6q7"
down_revision = "k1l2m3n4o5p6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reenrollment_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("matched_by", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("hostname", sa.String(length=255), nullable=True),
        sa.Column("current_user", sa.String(length=255), nullable=True),
        sa.Column("domain", sa.String(length=255), nullable=True),
        sa.Column("local_ip", sa.String(length=64), nullable=True),
        sa.Column("public_ip", sa.String(length=64), nullable=True),
        sa.Column("rustdesk_id", sa.String(length=64), nullable=True),
        sa.Column("os_caption", sa.String(length=255), nullable=True),
        sa.Column("platform", sa.String(length=64), nullable=True),
        sa.Column("token_name", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decided_by", sa.String(length=128), nullable=True),
        sa.Column("decision", sa.String(length=16), nullable=True),
        sa.Column("new_device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="SET NULL"), nullable=True),
        sa.UniqueConstraint("device_id", "agent_id", name="uq_reenrollment_request_device_agent"),
    )
    op.create_index("ix_reenrollment_requests_status", "reenrollment_requests", ["status"])
    op.add_column("remote_support_connections", sa.Column("close_reason", sa.String(length=16), nullable=True))
    op.add_column("devices", sa.Column("rustdesk_session_source", sa.String(length=16), nullable=True))
    op.add_column("devices", sa.Column("rustdesk_last_report_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "rustdesk_last_report_at")
    op.drop_column("devices", "rustdesk_session_source")
    op.drop_column("remote_support_connections", "close_reason")
    op.drop_index("ix_reenrollment_requests_status", table_name="reenrollment_requests")
    op.drop_table("reenrollment_requests")
