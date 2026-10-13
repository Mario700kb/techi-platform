"""audit_logs.device_id / client_id, backfilled from entity and details_json

Revision ID: g7h8i9j0k1l2
Revises: f6a7b8c9d0e1
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "g7h8i9j0k1l2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def _as_int(value):
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def upgrade() -> None:
    op.add_column("audit_logs", sa.Column("device_id", sa.Integer(), nullable=True))
    op.add_column("audit_logs", sa.Column("client_id", sa.Integer(), nullable=True))
    op.create_index("ix_audit_logs_device_id", "audit_logs", ["device_id"])
    op.create_index("ix_audit_logs_client_id", "audit_logs", ["client_id"])

    bind = op.get_bind()
    device_client = dict(bind.execute(sa.text("SELECT id, client_id FROM devices")).fetchall())
    rows = bind.execute(sa.text("SELECT id, entity_type, entity_id, details_json FROM audit_logs")).fetchall()
    updates = []
    for row_id, entity_type, entity_id, details_json in rows:
        try:
            details = json.loads(details_json) if details_json else {}
        except ValueError:
            details = {}
        if not isinstance(details, dict):
            details = {}
        device_id = entity_id if entity_type == "device" else _as_int(details.get("device_id"))
        client_id = entity_id if entity_type == "client" else _as_int(details.get("client_id"))
        if client_id is None and device_id is not None:
            client_id = device_client.get(device_id)
        if device_id is not None or client_id is not None:
            updates.append({"id": row_id, "device_id": device_id, "client_id": client_id})
    if updates:
        bind.execute(
            sa.text("UPDATE audit_logs SET device_id = :device_id, client_id = :client_id WHERE id = :id"),
            updates,
        )


def downgrade() -> None:
    op.drop_index("ix_audit_logs_client_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_device_id", table_name="audit_logs")
    op.drop_column("audit_logs", "client_id")
    op.drop_column("audit_logs", "device_id")
