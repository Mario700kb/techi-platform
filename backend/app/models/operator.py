from enum import Enum
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, false

from app.db.base import Base
from app.core.time import utcnow_naive


class OperatorRole(str, Enum):
    OWNER = "owner"
    ADMIN = "admin"
    OPERATOR = "operator"
    READONLY = "readonly"


class Operator(Base):
    __tablename__ = "operators"

    id = Column(Integer, primary_key=True)
    username = Column(String(80), unique=True, nullable=False)
    email = Column(String(120), unique=True, nullable=False)
    display_name = Column(String(255), nullable=True)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(32), default=OperatorRole.READONLY.value, nullable=False, index=True)
    is_active = Column(Boolean, default=True, nullable=False)
    is_superuser = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)
    last_login_at = Column(DateTime, nullable=True)
    # Two-factor authentication (TOTP). The secret is sealed with the vault
    # cipher; mfa_last_step blocks replaying a code inside its 30s window.
    mfa_enabled = Column(Boolean, default=False, nullable=False, server_default=false())
    mfa_secret_ciphertext = Column(Text, nullable=True)
    mfa_secret_dek = Column(Text, nullable=True)
    mfa_pending_ciphertext = Column(Text, nullable=True)
    mfa_pending_dek = Column(Text, nullable=True)
    mfa_recovery_codes = Column(Text, nullable=True)  # JSON list of sha256 hex digests
    mfa_last_step = Column(Integer, nullable=True)
    mfa_enabled_at = Column(DateTime, nullable=True)
