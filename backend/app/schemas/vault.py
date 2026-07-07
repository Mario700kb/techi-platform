from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.models.vault_credential import VaultCredentialType, VaultScopeType


class VaultCredentialCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    credential_type: VaultCredentialType
    scope_type: VaultScopeType = VaultScopeType.GLOBAL
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    device_id: Optional[int] = None
    username: Optional[str] = Field(default=None, max_length=160)
    secret: str = Field(min_length=1)
    notes: Optional[str] = Field(default=None, max_length=500)


class VaultCredentialUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    username: Optional[str] = Field(default=None, max_length=160)
    notes: Optional[str] = Field(default=None, max_length=500)
    # Providing a new secret rotates the credential (new DEK, rotated_at set)
    secret: Optional[str] = Field(default=None, min_length=1)


class VaultCredentialOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    credential_type: str
    scope_type: str
    client_id: Optional[int] = None
    group_id: Optional[int] = None
    device_id: Optional[int] = None
    username: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    rotated_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    # Never the secret — only a stable masked hint ("••••" + last 4 of name-scoped hash)
    secret_hint: Optional[str] = None


class VaultRevealRequest(BaseModel):
    reason: str = Field(min_length=5, max_length=300)


class VaultRevealResponse(BaseModel):
    id: int
    name: str
    username: Optional[str] = None
    secret: str


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
