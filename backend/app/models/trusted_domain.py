
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.core.time import utcnow_naive


class TrustedDomain(Base):
    __tablename__ = "trusted_domains"

    id = Column(Integer, primary_key=True)
    domain = Column(String(255), nullable=False, unique=True)
    client_name = Column(String(160), nullable=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)
    updated_at = Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False)

    client = relationship("Client")
