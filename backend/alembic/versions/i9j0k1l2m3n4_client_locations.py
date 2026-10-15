"""client_locations: a client's sites, the rules that recognise them, and
the site each device is at

Revision ID: i9j0k1l2m3n4
Revises: h8i9j0k1l2m3
"""
import sqlalchemy as sa
from alembic import op

revision = "i9j0k1l2m3n4"
down_revision = "h8i9j0k1l2m3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "client_locations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False, server_default="office"),
        sa.Column("country", sa.String(2), nullable=False),
        sa.Column("city", sa.String(80), nullable=False),
        sa.Column("address", sa.String(200), nullable=True),
        sa.Column("contact", sa.String(200), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(128), nullable=True),
        sa.Column("updated_by", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_client_locations_id", "client_locations", ["id"])
    op.create_index("ix_client_locations_client_id", "client_locations", ["client_id"])

    op.create_table(
        "client_location_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "location_id",
            sa.Integer(),
            sa.ForeignKey("client_locations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("public_ip", sa.String(45), nullable=True),
        sa.Column("lan_cidr", sa.String(49), nullable=True),
        sa.CheckConstraint("public_ip IS NOT NULL OR lan_cidr IS NOT NULL", name="ck_client_location_rules_not_empty"),
    )
    op.create_index("ix_client_location_rules_id", "client_location_rules", ["id"])
    op.create_index("ix_client_location_rules_location_id", "client_location_rules", ["location_id"])

    # Nullable columns without a default: a catalogue-only change on
    # PostgreSQL, no rewrite of the devices table.
    op.add_column("devices", sa.Column("location_id", sa.Integer(), nullable=True))
    op.add_column("devices", sa.Column("location_source", sa.String(16), nullable=True))
    op.create_foreign_key(
        "fk_devices_location_id",
        "devices",
        "client_locations",
        ["location_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_devices_location_id", "devices", ["location_id"])


def downgrade() -> None:
    op.drop_index("ix_devices_location_id", table_name="devices")
    op.drop_constraint("fk_devices_location_id", "devices", type_="foreignkey")
    op.drop_column("devices", "location_source")
    op.drop_column("devices", "location_id")
    op.drop_index("ix_client_location_rules_location_id", table_name="client_location_rules")
    op.drop_index("ix_client_location_rules_id", table_name="client_location_rules")
    op.drop_table("client_location_rules")
    op.drop_index("ix_client_locations_client_id", table_name="client_locations")
    op.drop_index("ix_client_locations_id", table_name="client_locations")
    op.drop_table("client_locations")
