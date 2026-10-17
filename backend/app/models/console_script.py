from sqlalchemy import Column, DateTime, Integer, String, Text

from app.core.time import utcnow_naive
from app.db.base import Base


class ConsoleScript(Base):
    """A saved PowerShell script an administrator runs inside an open
    administrator console on a Windows device. Runs as SYSTEM, like everything
    typed in that console; every run is audited with the script's version."""

    __tablename__ = "console_scripts"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False, unique=True)
    description = Column(String(500), nullable=True)
    body = Column(Text, nullable=False)
    version = Column(Integer, nullable=False, default=1)
    uses = Column(Integer, nullable=False, default=0)
    last_used_at = Column(DateTime, nullable=True)
    created_by = Column(String(128), nullable=True)
    updated_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)
    updated_at = Column(DateTime, default=utcnow_naive, nullable=False)
