from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.remote_support_connection import RemoteSupportConnection


class RemoteSupportConnectionRepository:
    """Queries only; the caller commits once per reported event."""

    def __init__(self, db: Session):
        self.db = db

    def add(self, connection: RemoteSupportConnection) -> RemoteSupportConnection:
        self.db.add(connection)
        self.db.flush()
        return connection

    def latest_open(self, device_id: int, conn_id: int) -> Optional[RemoteSupportConnection]:
        return (
            self.db.query(RemoteSupportConnection)
            .filter(
                RemoteSupportConnection.device_id == device_id,
                RemoteSupportConnection.conn_id == conn_id,
                RemoteSupportConnection.closed_at.is_(None),
            )
            .order_by(RemoteSupportConnection.opened_at.desc(), RemoteSupportConnection.id.desc())
            .first()
        )

    def close_open_for_conn(self, device_id: int, conn_id: int, *, now: datetime, reason: str) -> int:
        """Close any still-open connection reusing this conn_id. RustDesk numbers
        connections per process, so a new one with a conn_id already open means
        the old one was lost (a restart, or a close we never received)."""
        rows = (
            self.db.query(RemoteSupportConnection)
            .filter(
                RemoteSupportConnection.device_id == device_id,
                RemoteSupportConnection.conn_id == conn_id,
                RemoteSupportConnection.closed_at.is_(None),
            )
            .all()
        )
        for row in rows:
            row.closed_at = now
            row.close_reason = reason
        return len(rows)

    def count_open_authorized(self, device_id: int, *, since: datetime) -> int:
        return (
            self.db.query(RemoteSupportConnection)
            .filter(
                RemoteSupportConnection.device_id == device_id,
                RemoteSupportConnection.authorized_at.isnot(None),
                RemoteSupportConnection.closed_at.is_(None),
                RemoteSupportConnection.opened_at >= since,
            )
            .count()
        )
