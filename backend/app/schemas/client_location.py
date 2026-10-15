import ipaddress
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

LocationKind = Literal["office", "branch", "shop", "warehouse", "datacenter", "other"]


class LocationRuleIn(BaseModel):
    public_ip: Optional[str] = Field(default=None, max_length=45)
    lan_cidr: Optional[str] = Field(default=None, max_length=49)

    @field_validator("public_ip")
    @classmethod
    def _ip(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return None
        try:
            return str(ipaddress.ip_address(value.strip()))
        except ValueError:
            raise ValueError("Not an IP address")

    @field_validator("lan_cidr")
    @classmethod
    def _cidr(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return None
        try:
            # strict=False: "10.130.50.7/24" is read as its network, 10.130.50.0/24.
            return str(ipaddress.ip_network(value.strip(), strict=False))
        except ValueError:
            raise ValueError("Not a network, e.g. 10.130.50.0/24")

    @model_validator(mode="after")
    def _not_empty(self):
        if self.public_ip is None and self.lan_cidr is None:
            raise ValueError("A rule needs a public IP, a LAN network, or both")
        return self


class LocationRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    public_ip: Optional[str] = None
    lan_cidr: Optional[str] = None


class LocationBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: LocationKind = "office"
    country: str = Field(min_length=2, max_length=2)
    city: str = Field(min_length=1, max_length=80)
    address: Optional[str] = Field(default=None, max_length=200)
    contact: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = Field(default=None, max_length=4000)

    @field_validator("name", "city")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Required")
        return value

    @field_validator("country")
    @classmethod
    def _country(cls, value: str) -> str:
        value = value.strip().upper()
        if not value.isalpha():
            raise ValueError("Two-letter country code, e.g. AL")
        return value


class LocationCreate(LocationBase):
    rules: List[LocationRuleIn] = Field(default_factory=list, max_length=50)


class LocationUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    kind: Optional[LocationKind] = None
    country: Optional[str] = Field(default=None, min_length=2, max_length=2)
    city: Optional[str] = Field(default=None, min_length=1, max_length=80)
    address: Optional[str] = Field(default=None, max_length=200)
    contact: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = Field(default=None, max_length=4000)
    # When given, replaces every rule of the location.
    rules: Optional[List[LocationRuleIn]] = Field(default=None, max_length=50)

    @field_validator("name", "city")
    @classmethod
    def _strip(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else LocationBase._strip(value)

    @field_validator("country")
    @classmethod
    def _country(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else LocationBase._country(value)


class LocationStats(BaseModel):
    total: int = 0
    online: int = 0
    stale: int = 0
    offline: int = 0
    servers: int = 0
    clientpc: int = 0


class LocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    client_id: int
    name: str
    kind: str
    country: str
    city: str
    address: Optional[str] = None
    contact: Optional[str] = None
    notes: Optional[str] = None
    rules: List[LocationRuleOut] = Field(default_factory=list)
    stats: LocationStats = Field(default_factory=LocationStats)
    manual_devices: int = 0
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class LocationList(BaseModel):
    locations: List[LocationOut]
    # The client's devices at no location (roaming, or no rule matches yet).
    unlocated: LocationStats


class SuggestionNetwork(BaseModel):
    lan_cidr: str
    devices: int


class LocationSuggestion(BaseModel):
    """A public IP that several of the client's unlocated devices share."""

    public_ip: str
    devices: int
    online: int
    networks: List[SuggestionNetwork]
    other_network_devices: int
    sample_hostnames: List[str]


class LocationApplyResult(BaseModel):
    assigned: int
    cleared: int


class DeviceLocationAssign(BaseModel):
    device_ids: List[int] = Field(min_length=1, max_length=1000)
    # None with mode "manual" pins the devices to "no location".
    location_id: Optional[int] = None
    # "manual": pinned, rules leave them alone. "auto": back to the rules.
    mode: Literal["manual", "auto"] = "manual"
