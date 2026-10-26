from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String

from app.core.time import utcnow_naive
from app.db.base import Base


class RemoteSupportConnection(Base):
    """One incoming TECHI Remote Support (RustDesk) connection, as RustDesk on
    the device reports it to /api/audit/conn: opened, password accepted, closed.

    RustDesk numbers connections per process (conn_id restarts with the
    service); session_id is the controlling client's session, kept when that
    client reconnects, so a drop and its reconnection share it.
    """

    __tablename__ = "remote_support_connections"

    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    conn_id = Column(Integer, nullable=False)
    session_id = Column(String(32), nullable=True)
    peer_id = Column(String(64), nullable=True)
    peer_name = Column(String(128), nullable=True)
    peer_ip = Column(String(64), nullable=True)
    conn_type = Column(Integer, nullable=True)
    opened_at = Column(DateTime(timezone=True), nullable=False, default=utcnow_naive)
    authorized_at = Column(DateTime(timezone=True), nullable=True)
    closed_at = Column(DateTime(timezone=True), nullable=True)
    # closed: RustDesk reported the close. lost: a newer connection showed this
    # one was gone without a close (RustDesk restarted, or the client reconnected).
    close_reason = Column(String(16), nullable=True)

    __table_args__ = (
        Index("ix_remote_support_connections_device_conn", "device_id", "conn_id"),
        Index("ix_remote_support_connections_opened_at", "opened_at"),
    )
