from sqlalchemy import Column, DateTime, ForeignKey, Integer, Text

from app.core.time import utcnow
from app.db.base import Base


class DeviceInventory(Base):
    __tablename__ = "device_inventory"

    id = Column(Integer, primary_key=True)
    device_id = Column(
        Integer,
        ForeignKey("devices.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    processes_json = Column(Text, nullable=True)
    services_json = Column(Text, nullable=True)
    software_json = Column(Text, nullable=True)
    patch_json = Column(Text, nullable=True)
    # Windows security posture (agent >= 2.1.31): the normalised JSON of
    # app.schemas.security_posture.SecurityPosture, and when the agent read it.
    security_json = Column(Text, nullable=True)
    security_collected_at = Column(DateTime, nullable=True)
    # Device health (agent >= 2.1.33): the normalised JSON of
    # app.schemas.device_health.DeviceHealth — physical disks, pending restart,
    # critical System events (merged, 7 days) — and when it was stored.
    health_json = Column(Text, nullable=True)
    health_collected_at = Column(DateTime, nullable=True)
    collected_at = Column(DateTime, nullable=False, default=utcnow)
