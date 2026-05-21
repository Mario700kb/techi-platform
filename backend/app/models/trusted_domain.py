from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String

from app.db.base import Base


class TrustedDomain(Base):
    __tablename__ = "trusted_domains"

    id = Column(Integer, primary_key=True, index=True)
    domain = Column(String(255), nullable=False, unique=True, index=True)
    client_name = Column(String(160), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
