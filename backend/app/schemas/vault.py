from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.models.vault_credential import VaultCredentialType, VaultScopeType


class VaultCredentialCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    credential_type: VaultCredentialType
    scope_type: VaultScopeType = VaultScopeType.GLOBAL
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    device_id: Optional[int] = None
    purpose: Optional[str] = Field(default=None, max_length=64)
    username: Optional[str] = Field(default=None, max_length=160)
    # Legacy convenience for single-secret-field types (back-compat with the
    # original API contract); new metadata-driven forms send secret_fields.
    secret: Optional[str] = Field(default=None, min_length=1)
    secret_fields: Optional[Dict[str, str]] = None
    metadata: Optional[Dict[str, str]] = None
    notes: Optional[str] = Field(default=None, max_length=500)
    expires_at: Optional[datetime] = None
    rotation_due_at: Optional[datetime] = None


class VaultCredentialUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    username: Optional[str] = Field(default=None, max_length=160)
    purpose: Optional[str] = Field(default=None, max_length=64)
    notes: Optional[str] = Field(default=None, max_length=500)
    metadata: Optional[Dict[str, str]] = None
    expires_at: Optional[datetime] = None
    rotation_due_at: Optional[datetime] = None
    status: Optional[str] = None  # "active" | "disabled"
    # Providing a new secret rotates the credential (new DEK, rotated_at set)
    secret: Optional[str] = Field(default=None, min_length=1)
    secret_fields: Optional[Dict[str, str]] = None


class VaultCredentialOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    credential_type: str
    scope_type: str
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    device_id: Optional[int] = None
    purpose: Optional[str] = None
    username: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    rotated_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    status: str = "active"
    expires_at: Optional[datetime] = None
    rotation_due_at: Optional[datetime] = None
    last_tested_at: Optional[datetime] = None
    last_test_status: Optional[str] = None
    # Named credential_metadata, not "metadata" — every SQLAlchemy declarative
    # model instance already has a reserved `.metadata` attribute (the
    # MetaData registry), so model_validate(from_attributes=True) would read
    # THAT instead of the intended non-secret type-specific fields.
    credential_metadata: Dict[str, str] = Field(default_factory=dict)
    # Never the secret — only a stable masked hint ("••••" + last 4 of name-scoped hash)
    secret_hint: Optional[str] = None
    # Computed, not stored — see VaultService.enrich()
    lifecycle_status: str = "active"  # active|disabled|expiring_soon|expired|validation_failed
    is_referenced: bool = False
    reference_count: int = 0
    references: List[str] = Field(default_factory=list)
    consumer_status: str = "no_active_consumer"
    future_consumers: List[str] = Field(default_factory=list)
    # Real, live usage — populated once a real connection (Embedded SSH
    # Connect today) has actually authenticated with this credential, as
    # opposed to future_consumers (a static registry hint). See
    # VaultService.record_credential_use()/enrich().
    used_by: List[str] = Field(default_factory=list)


class VaultRevealRequest(BaseModel):
    reason: str = Field(min_length=5, max_length=300)


class VaultRevealResponse(BaseModel):
    id: int
    name: str
    username: Optional[str] = None
    secret_fields: Dict[str, str] = Field(default_factory=dict)


class VaultUsageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    credential_id: int
    operator_username: Optional[str] = None
    device_id: Optional[int] = None
    action: str
    reason: Optional[str] = None
    created_at: datetime


class VaultUsageList(BaseModel):
    items: List[VaultUsageOut]


class VaultAssignmentCreate(BaseModel):
    client_id: Optional[int] = None
    device_id: Optional[int] = None


class VaultAssignmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    credential_id: int
    client_id: Optional[int] = None
    client_name: Optional[str] = None
    device_id: Optional[int] = None
    device_name: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime


class VaultTestResult(BaseModel):
    status: str  # "success" | "failed" | "unsupported"
    message: str


class VaultFieldSpecOut(BaseModel):
    key: str
    label: str
    required: bool
    kind: str
    options: Optional[List[str]] = None
    default: Optional[str] = None
    placeholder: Optional[str] = None


class VaultCredentialTypeOut(BaseModel):
    id: str
    label: str
    icon: str
    category: str
    metadata_fields: List[VaultFieldSpecOut]
    secret_fields: List[VaultFieldSpecOut]
    requires_username: bool
    requires_secret: bool
    future_consumers: List[str]
    legacy: bool
