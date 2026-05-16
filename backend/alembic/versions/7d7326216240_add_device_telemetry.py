"""A generic migration script template for Alembic.

Revision ID: 7d7326216240
Revises: 8b2f4d7c9a10
Create Date: 2026-05-11 14:21:11.138214
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '7d7326216240'
down_revision = '8b2f4d7c9a10'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'device_telemetry',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('device_id', sa.Integer(), nullable=False),
        sa.Column('cpu_percent', sa.Float(), nullable=True),
        sa.Column('ram_percent', sa.Float(), nullable=True),
        sa.Column('disk_percent', sa.Float(), nullable=True),
        sa.Column('uptime_seconds', sa.Integer(), nullable=True),
        sa.Column('heartbeat_latency_ms', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['device_id'], ['devices.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_device_telemetry_id'), 'device_telemetry', ['id'], unique=False)
    op.create_index(op.f('ix_device_telemetry_device_id'), 'device_telemetry', ['device_id'], unique=False)
    op.create_index(op.f('ix_device_telemetry_created_at'), 'device_telemetry', ['created_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_device_telemetry_created_at'), table_name='device_telemetry')
    op.drop_index(op.f('ix_device_telemetry_device_id'), table_name='device_telemetry')
    op.drop_index(op.f('ix_device_telemetry_id'), table_name='device_telemetry')
    op.drop_table('device_telemetry')
