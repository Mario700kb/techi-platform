from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ClientBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: Optional[str] = Field(default=None, max_length=140)
    description: Optional[str] = None
    is_active: bool = True


class ClientCreate(ClientBase):
    pass


class ClientUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = None
    is_active: Optional[bool] = None


class Client(ClientBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    created_at: datetime


class ClientProfileGroup(BaseModel):
    id: int
    name: str
    devices: int


class ClientActivityPage(BaseModel):
    total: int
    items: List["AuditLogOut"]
    # Current name of every device the page's entries mention.
    device_names: Dict[int, str] = {}


class ClientProfile(BaseModel):
    """Everything the client profile's header and Overview show, in one request."""

    client: Client
    stats: "DeviceStats"
    by_category: Dict[str, "DeviceStats"] = {}
    alerts: "AlertCountResponse"
    average_health: Optional[int] = None
    health_critical: int = 0
    health_warning: int = 0
    needs_updates: int = 0
    agents_outdated: int = 0
    groups: List[ClientProfileGroup] = []
    last_seen: Optional[datetime] = None


from app.schemas.alert import AlertCountResponse  # noqa: E402
from app.schemas.audit_log import AuditLogOut  # noqa: E402
from app.schemas.device import DeviceStats  # noqa: E402

ClientProfile.model_rebuild()
ClientActivityPage.model_rebuild()
