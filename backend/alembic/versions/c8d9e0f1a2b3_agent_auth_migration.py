"""add staged agent authentication migration state"""

from alembic import op
import sqlalchemy as sa

revision = "c8d9e0f1a2b3"
down_revision = ("z1a2b3c4d5e6", "v6w7x8y9z0a1")
branch_labels = None
depends_on = None


def upgrade():
    for name, column in (
        ("agent_auth_migration_public_key", sa.Text()),
        ("agent_auth_migration_fingerprint", sa.String(64)),
        ("agent_auth_migration_challenge_hash", sa.String(64)),
        ("agent_auth_migration_challenge_expires_at", sa.DateTime()),
        ("agent_auth_migration_proof_verified_at", sa.DateTime()),
        ("agent_auth_migration_approved_at", sa.DateTime()),
        ("agent_auth_migration_completed_at", sa.DateTime()),
    ):
        op.add_column("devices", sa.Column(name, column, nullable=True))
    op.add_column(
        "devices",
        sa.Column("agent_auth_migration_status", sa.String(32), nullable=False, server_default="none"),
    )
    op.create_index(
        "ix_devices_agent_auth_migration_fingerprint",
        "devices",
        ["agent_auth_migration_fingerprint"],
        unique=False,
    )


def downgrade():
    op.drop_index("ix_devices_agent_auth_migration_fingerprint", table_name="devices")
    for name in (
        "agent_auth_migration_status",
        "agent_auth_migration_completed_at",
        "agent_auth_migration_approved_at",
        "agent_auth_migration_proof_verified_at",
        "agent_auth_migration_challenge_expires_at",
        "agent_auth_migration_challenge_hash",
        "agent_auth_migration_fingerprint",
        "agent_auth_migration_public_key",
    ):
        op.drop_column("devices", name)
