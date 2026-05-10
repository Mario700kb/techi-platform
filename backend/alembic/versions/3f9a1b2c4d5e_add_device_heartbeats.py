"""Add device heartbeats table

Revision ID: 3f9a1b2c4d5e
Revises: 0ddbbdb6e4bd
Create Date: 2026-05-10 12:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '3f9a1b2c4d5e'
down_revision = '0ddbbdb6e4bd'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'device_heartbeats',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('device_id', sa.Integer(), nullable=False),
        sa.Column('rustdesk_id', sa.String(length=64), nullable=False),
        sa.Column('hostname', sa.String(length=128), nullable=True),
        sa.Column('current_user', sa.String(length=128), nullable=True),
        sa.Column('domain', sa.String(length=128), nullable=True),
        sa.Column('public_ip', sa.String(length=45), nullable=True),
        sa.Column('local_ip', sa.String(length=45), nullable=True),
        sa.Column('os_name', sa.String(length=80), nullable=True),
        sa.Column('os_version', sa.String(length=80), nullable=True),
        sa.Column('platform', sa.String(length=80), nullable=True),
        sa.Column('device_type', sa.Enum('server', 'client', 'unassigned', name='devicetype'), nullable=False),
        sa.Column('status', sa.Enum('online', 'offline', name='devicestatus'), nullable=False),
        sa.Column('cpu', sa.String(length=120), nullable=True),
        sa.Column('ram', sa.String(length=120), nullable=True),
        sa.Column('storage', sa.String(length=120), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_device_heartbeats_id'), 'device_heartbeats', ['id'], unique=False)
    op.create_index(op.f('ix_device_heartbeats_device_id'), 'device_heartbeats', ['device_id'], unique=False)
    op.create_index(op.f('ix_device_heartbeats_rustdesk_id'), 'device_heartbeats', ['rustdesk_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_device_heartbeats_rustdesk_id'), table_name='device_heartbeats')
    op.drop_index(op.f('ix_device_heartbeats_device_id'), table_name='device_heartbeats')
    op.drop_index(op.f('ix_device_heartbeats_id'), table_name='device_heartbeats')
    op.drop_table('device_heartbeats')
