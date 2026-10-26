from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint

from app.core.time import utcnow_naive
from app.db.base import Base


class RemoteSupportPeer(Base):
    """A TECHI Remote Support (RustDesk) client as it describes itself.

    Every client posts {id, uuid} to its api-server (the platform) every 15
    seconds and its system info (hostname, user, OS) when it changes. The uuid
    is base64 of the machine's MachineGuid, so it ties the ID shown in the
    client's window to one physical machine: the source of truth for the
    device's Remote Support ID, whatever the agent read from config files.

    One row per (uuid, rustdesk_id): cloned machines share a MachineGuid and
    show up as two rows that both keep reporting; an ID that changed shows up
    as a new row while the old one goes quiet.
    """

    __tablename__ = "remote_support_peers"
    __table_args__ = (
        UniqueConstraint("uuid", "rustdesk_id", name="uq_remote_support_peers_uuid_id"),
        Index("ix_remote_support_peers_rustdesk_id", "rustdesk_id"),
        Index("ix_remote_support_peers_machine_guid", "machine_guid"),
    )

    id = Column(Integer, primary_key=True)
    uuid = Column(String(128), nullable=False, index=True)
    machine_guid = Column(String(64), nullable=True)
    rustdesk_id = Column(String(32), nullable=False)
    hostname = Column(String(255), nullable=True)
    username = Column(String(255), nullable=True)
    os = Column(String(255), nullable=True)
    version = Column(String(32), nullable=True)
    source_ip = Column(String(64), nullable=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True)
    # machine_guid | same_machine | id_match | hostname_ip | manual
    bound_by = Column(String(16), nullable=True)
    bound_at = Column(DateTime(timezone=True), nullable=True)
    first_seen_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False)
    last_seen_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False, index=True)
    sysinfo_at = Column(DateTime(timezone=True), nullable=True)
    # Why it is not applied to its device, when it is not (clone, conflict…).
    note = Column(String(255), nullable=True)
