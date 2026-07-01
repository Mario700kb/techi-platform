from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TrustedDomainBase(BaseModel):
    domain: str = Field(min_length=1, max_length=255)
    client_id: Optional[int] = None
    client_name: Optional[str] = Field(default=None, max_length=160)
    is_active: bool = True

    @field_validator("domain")
    @classmethod
    def normalize_domain(cls, value: str) -> str:
        return value.strip().lower().rstrip(".")

    @field_validator("client_name")
    @classmethod
    def normalize_client_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None


class TrustedDomainCreate(TrustedDomainBase):
    pass


class TrustedDomainUpdate(BaseModel):
    domain: Optional[str] = Field(default=None, min_length=1, max_length=255)
    client_id: Optional[int] = None
    client_name: Optional[str] = Field(default=None, max_length=160)
    is_active: Optional[bool] = None

    @field_validator("domain")
    @classmethod
    def normalize_domain(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return value.strip().lower().rstrip(".")

    @field_validator("client_name")
    @classmethod
    def normalize_client_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None


class TrustedDomain(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    domain: str
    client_id: Optional[int] = None
    client_name: Optional[str] = None
    resolved_client_name: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime
