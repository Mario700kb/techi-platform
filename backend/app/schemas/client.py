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


class SessionSpan(BaseModel):
    duration_seconds: Optional[int] = None
    live_since: Optional[datetime] = None  # still open: started then
    end_reason: Optional[str] = None
    no_session: bool = False  # a Connect click that opened no session
    joined: bool = False  # a Connect click into a session already open


class ClientActivityPage(BaseModel):
    total: int
    items: List["AuditLogOut"]
    # Current name of every device the page's entries mention.
    device_names: Dict[int, str] = {}
    # For entries that start a session (Connect, Remote Support session
    # started, terminal/PowerShell/SSH opened), keyed by entry id: how long it
    # lasted, or since when it is still open.
    sessions: Dict[int, SessionSpan] = {}


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


class ClientActivityOperator(BaseModel):
    username: str
    events: int
    remote_connects: int
    last_at: Optional[datetime] = None


class ClientActivityDevice(BaseModel):
    device_id: int
    name: str
    remote_connects: int
    last_at: Optional[datetime] = None


class ClientActivitySummary(BaseModel):
    """The client's activity over the last `days`: remote connections, who
    made them and to which devices, and time in terminal/SSH sessions and in
    Remote Support sessions reported by agents that send them."""

    days: int
    since: datetime
    events: int
    remote_connects: int
    remote_devices: int
    last_remote_at: Optional[datetime] = None
    terminal_sessions: int
    terminal_seconds: int
    # Remote Support sessions ended, from agents that report sessions; 0 until then.
    remote_sessions: int
    remote_minutes: int
    operators: List[ClientActivityOperator] = []
    devices: List[ClientActivityDevice] = []


from app.schemas.alert import AlertCountResponse  # noqa: E402
from app.schemas.audit_log import AuditLogOut  # noqa: E402
from app.schemas.device import DeviceStats  # noqa: E402

ClientProfile.model_rebuild()
ClientActivityPage.model_rebuild()
