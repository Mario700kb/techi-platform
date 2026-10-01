"""Add device scope and report type to existing report runs.

Revision ID: d8e4f6a1b2c3
Revises: c7n1t8h5p2r6
"""

from alembic import op
import sqlalchemy as sa


revision = "d8e4f6a1b2c3"
down_revision = "c7n1t8h5p2r6"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("report_runs") as batch:
        batch.alter_column("client_id", existing_type=sa.Integer(), nullable=True)
        batch.add_column(sa.Column("scope_type", sa.String(16), nullable=False, server_default="client"))
        batch.add_column(sa.Column("device_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("device_name", sa.String(160), nullable=True))
        batch.add_column(sa.Column("group_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("report_type", sa.String(32), nullable=False, server_default="full"))
        batch.create_check_constraint("ck_report_runs_scope_type", "scope_type IN ('client', 'device')")
        batch.create_check_constraint("ck_report_runs_target", "(scope_type = 'client' AND client_id IS NOT NULL AND device_id IS NULL) OR (scope_type = 'device' AND device_id IS NOT NULL)")


def downgrade():
    if op.get_bind().execute(sa.text("SELECT COUNT(*) FROM report_runs WHERE scope_type = 'device'")).scalar():
        raise RuntimeError("Delete or export device report runs before downgrading this migration")
    with op.batch_alter_table("report_runs") as batch:
        batch.drop_constraint("ck_report_runs_target", type_="check")
        batch.drop_constraint("ck_report_runs_scope_type", type_="check")
        batch.drop_column("report_type")
        batch.drop_column("device_name")
        batch.drop_column("group_id")
        batch.drop_column("device_id")
        batch.drop_column("scope_type")
        batch.alter_column("client_id", existing_type=sa.Integer(), nullable=False)
