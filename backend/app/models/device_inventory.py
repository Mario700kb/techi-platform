from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, Text

from app.db.base import Base


class DeviceInventory(Base):
    __tablename__ = "device_inventory"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(
        Integer,
        ForeignKey("devices.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    processes_json = Column(Text, nullable=True)
    services_json = Column(Text, nullable=True)
    software_json = Column(Text, nullable=True)
    patch_json = Column(Text, nullable=True)
    collected_at = Column(DateTime, nullable=False, default=datetime.utcnow)
