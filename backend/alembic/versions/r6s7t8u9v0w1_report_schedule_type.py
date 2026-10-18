"""Scheduled reports choose their client report type

Revision ID: r6s7t8u9v0w1
Revises: q5r6s7t8u9v0
Create Date: 2026-10-17 21:30:00.000000

report_schedules.report_type: a key of the client report catalog
(app/services/client_reports/catalog.py). Existing schedules keep producing
the original "full" report.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "r6s7t8u9v0w1"
down_revision: Union[str, None] = "q5r6s7t8u9v0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "report_schedules",
        sa.Column("report_type", sa.String(length=32), nullable=False, server_default="full"),
    )


def downgrade() -> None:
    op.drop_column("report_schedules", "report_type")
