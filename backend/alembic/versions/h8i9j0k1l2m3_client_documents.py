"""client_documents: documentation pages on a client's profile

Revision ID: h8i9j0k1l2m3
Revises: g7h8i9j0k1l2
"""
import sqlalchemy as sa
from alembic import op

revision = "h8i9j0k1l2m3"
down_revision = "g7h8i9j0k1l2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "client_documents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("category", sa.String(40), nullable=False, server_default="general"),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(128), nullable=True),
        sa.Column("updated_by", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_client_documents_id", "client_documents", ["id"])
    op.create_index("ix_client_documents_client_id", "client_documents", ["client_id"])


def downgrade() -> None:
    op.drop_index("ix_client_documents_client_id", table_name="client_documents")
    op.drop_index("ix_client_documents_id", table_name="client_documents")
    op.drop_table("client_documents")
