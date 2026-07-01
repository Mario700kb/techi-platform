"""add trusted domain client mapping

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-07-01

"""
from alembic import op
import sqlalchemy as sa

revision = "e6f7a8b9c0d1"
down_revision = "d5e6f7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("trusted_domains", sa.Column("client_id", sa.Integer(), nullable=True))
    op.create_index("ix_trusted_domains_client_id", "trusted_domains", ["client_id"], unique=False)
    op.create_foreign_key(
        "fk_trusted_domains_client_id_clients",
        "trusted_domains",
        "clients",
        ["client_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_trusted_domains_client_id_clients", "trusted_domains", type_="foreignkey")
    op.drop_index("ix_trusted_domains_client_id", table_name="trusted_domains")
    op.drop_column("trusted_domains", "client_id")
