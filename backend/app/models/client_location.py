from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.core.time import utcnow_naive
from app.db.base import Base


class ClientLocation(Base):
    """One of a client's sites: an office, branch, shop, warehouse or data
    centre. Devices belong to it by a rule (the site's public IP and/or LAN)
    or because an operator put them there."""

    __tablename__ = "client_locations"

    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    kind = Column(String(20), nullable=False, default="office")
    country = Column(String(2), nullable=False)
    city = Column(String(80), nullable=False)
    address = Column(String(200), nullable=True)
    contact = Column(String(200), nullable=True)
    notes = Column(Text, nullable=True)
    created_by = Column(String(128), nullable=True)
    updated_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)
    updated_at = Column(DateTime, default=utcnow_naive, nullable=False)

    rules = relationship(
        "ClientLocationRule",
        back_populates="location",
        cascade="all, delete-orphan",
        order_by="ClientLocationRule.id",
        lazy="selectin",
    )


class ClientLocationRule(Base):
    """How a device is recognised as being at a location: its public IP, its
    LAN network, or both (both is the most specific)."""

    __tablename__ = "client_location_rules"

    id = Column(Integer, primary_key=True)
    location_id = Column(Integer, ForeignKey("client_locations.id", ondelete="CASCADE"), nullable=False, index=True)
    public_ip = Column(String(45), nullable=True)
    lan_cidr = Column(String(49), nullable=True)

    location = relationship("ClientLocation", back_populates="rules")
