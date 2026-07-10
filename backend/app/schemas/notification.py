from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.models.notification import NotificationChannelType, NotificationScopeType


class NotificationChannelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    channel_type: NotificationChannelType
    enabled: bool = True
    # Channel-type-specific, non-secret shape:
    #   email:   {smtp_host, smtp_port, use_tls, username, from_address, to_addresses:[..]}
    #   webhook: {url, headers: {..}}
    config: Dict[str, Any]
    # SMTP password / webhook shared secret — stored encrypted, never returned.
    secret: Optional[str] = None


class NotificationChannelUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    enabled: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None
    secret: Optional[str] = None  # providing a value rotates it


class NotificationChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=False)

    id: int
    name: str
    channel_type: str
    enabled: bool
    config: Dict[str, Any]
    has_secret: bool
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class NotificationRuleCreate(BaseModel):
    event_type: str = Field(min_length=1, max_length=64)
    scope_type: NotificationScopeType = NotificationScopeType.GLOBAL
    client_id: Optional[int] = None
    channel_id: int
    enabled: bool = True
    min_severity: Optional[str] = None
    cooldown_seconds: int = Field(default=0, ge=0)
    rate_limit_per_hour: Optional[int] = Field(default=None, ge=1)


class NotificationRuleUpdate(BaseModel):
    enabled: Optional[bool] = None
    min_severity: Optional[str] = None
    cooldown_seconds: Optional[int] = Field(default=None, ge=0)
    rate_limit_per_hour: Optional[int] = Field(default=None, ge=1)


class NotificationRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_type: str
    scope_type: str
    client_id: Optional[int] = None
    channel_id: int
    enabled: bool
    min_severity: Optional[str] = None
    cooldown_seconds: int
    rate_limit_per_hour: Optional[int] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class NotificationDeliveryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rule_id: Optional[int] = None
    channel_id: int
    event_type: str
    device_id: Optional[int] = None
    client_id: Optional[int] = None
    title: str
    status: str
    attempt_count: int
    last_error: Optional[str] = None
    created_at: datetime
    sent_at: Optional[datetime] = None


class NotificationDeliveryList(BaseModel):
    items: List[NotificationDeliveryOut]
    total: int


class NotificationTestRequest(BaseModel):
    message: Optional[str] = Field(default=None, max_length=500)


class NotificationTestResult(BaseModel):
    success: bool
    error: Optional[str] = None
