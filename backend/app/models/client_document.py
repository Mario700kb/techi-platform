from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text

from app.core.time import utcnow_naive
from app.db.base import Base


class ClientDocument(Base):
    """A documentation page kept on a client's profile (network, procedures,
    contacts…). Markdown text; secrets belong in the Credential Vault."""

    __tablename__ = "client_documents"

    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    category = Column(String(40), nullable=False, default="general")
    body = Column(Text, nullable=False, default="")
    pinned = Column(Boolean, nullable=False, default=False)
    created_by = Column(String(128), nullable=True)
    updated_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow_naive, nullable=False)
