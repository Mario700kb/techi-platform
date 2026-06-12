from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

class EnrollmentTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    expires_at: Optional[datetime] = None
    max_uses: int = Field(default=1, ge=1, le=1000000)
    client_id: Optional[int] = None
    group_id: Optional[int] = None


class EnrollmentTokenOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    status: str
    created_at: datetime
    expires_at: Optional[datetime]
    used_at: Optional[datetime]
    max_uses: int
    use_count: int
    client_id: Optional[int]
    group_id: Optional[int]
    is_default: bool = False
    token_prefix: Optional[str] = None
    has_recoverable_token: bool = False
    usage_warning: Optional[str] = None


class EnrollmentTokenCreateResponse(EnrollmentTokenOut):
    token: str


class EnrollmentTokenUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    expires_at: Optional[datetime] = None
    max_uses: Optional[int] = Field(default=None, ge=1, le=1000000)
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    status: Optional[str] = Field(default=None, pattern="^(active|revoked)$")


class EnrollmentTokenDeployment(BaseModel):
    token_id: int
    token_name: str
    token_prefix: Optional[str] = None
    token_available: bool
    bootstrap_url: str
    manual_command: str
    gpo_command: str
    gpo_deploy_command: str
    token_metadata: EnrollmentTokenOut
    rustdesk: dict


class EnrollmentTokenVerifyRequest(BaseModel):
    token: str = Field(min_length=16)


class EnrollmentTokenVerifyResponse(BaseModel):
    valid: bool
    status: str
    token_id: Optional[int] = None
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    message: str


class EnrollmentAuditEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    token_id: Optional[int] = None
    token_name: Optional[str] = None
    token_prefix: Optional[str] = None
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    device_id: Optional[int] = None
    hostname: Optional[str] = None
    username: Optional[str] = None
    domain: Optional[str] = None
    rustdesk_id: Optional[str] = None
    public_ip: Optional[str] = None
    local_ip: Optional[str] = None
    result: str
    reason: Optional[str] = None
    raw_error: Optional[str] = None
    fingerprint: Optional[str] = None
    agent_id: Optional[str] = None


class EnrollmentTokenDiagnostics(BaseModel):
    token: EnrollmentTokenOut
    uses: int
    max_uses: int
    unique_devices: Optional[int] = None
    duplicate_enrollments: Optional[int] = None
    successful_events: Optional[int] = None
    failed_events: Optional[int] = None
    archived_devices: Optional[int] = None
    orphaned_uses: Optional[int] = None
    inferred: bool
    inference_note: Optional[str] = None
    last_events: List[EnrollmentAuditEventOut]
