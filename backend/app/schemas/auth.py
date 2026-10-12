from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, field_validator

from app.schemas.operator import Operator


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: Operator


class LoginResult(BaseModel):
    """A password sign-in either completes (session cookies are set) or asks
    for the second factor with a short-lived challenge token."""
    mfa_required: bool = False
    mfa_token: Optional[str] = None
    user: Optional[Operator] = None
    session_expires_at: Optional[datetime] = None
    access_expires_at: Optional[datetime] = None


class MfaLoginRequest(BaseModel):
    mfa_token: str
    code: str


class SessionInfo(BaseModel):
    session_expires_at: datetime
    # When the access cookie just set expires; the browser renews before it.
    access_expires_at: datetime


class AuthSession(BaseModel):
    user: Operator
    permissions: List[str]
    denied: List[str]
    session_expires_at: Optional[datetime] = None
    access_expires_at: Optional[datetime] = None
    mfa_enrollment_required: bool = False


class OperatorSessionOut(BaseModel):
    id: str
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    current: bool = False


class MfaStatus(BaseModel):
    enabled: bool
    enabled_at: Optional[datetime] = None
    required: bool
    recovery_codes_remaining: int


class MfaSetup(BaseModel):
    secret: str
    otpauth_uri: str


class MfaCode(BaseModel):
    code: str


class MfaDisableRequest(BaseModel):
    password: str
    code: str


class RecoveryCodes(BaseModel):
    recovery_codes: List[str]


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_strength(cls, v: str) -> str:
        if len(v.strip()) < 8:
            raise ValueError("New password must be at least 8 characters")
        return v
