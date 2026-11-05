from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel


class RiskDevice(BaseModel):
    id: int
    name: str
    client_name: Optional[str] = None
    detail: str


class RiskCheck(BaseModel):
    key: str
    label: str
    group: Literal["security", "health"]
    severity: Literal["critical", "warning"]
    count: int
    # At most a few, most serious first; `count` is the full number.
    devices: List[RiskDevice]


class SecuritySummary(BaseModel):
    # Devices that reported a security posture (Windows agents from 2.1.31).
    reported: int
    average_score: Optional[float] = None
    # Antivirus with real-time protection on.
    protected: int


class AgentVersionCount(BaseModel):
    family: Literal["windows", "linux"]
    version: str
    count: int


class FleetRisk(BaseModel):
    devices: int
    security: SecuritySummary
    health_reported: int
    checks: List[RiskCheck]
    agent_versions: List[AgentVersionCount]
    generated_at: datetime
