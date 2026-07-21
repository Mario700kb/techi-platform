"""Read-only response schema for the Platform Components registry endpoint.

Exposes ONLY stable strings (never a Python enum repr). Additive + versioned:
`schema_version` lets the frontend evolve backward-compatibly, and new optional
fields can be added without breaking older clients.
"""
from typing import List, Optional

from pydantic import BaseModel


class ComponentLifecycleOut(BaseModel):
    operation: str                    # LifecycleOperation value (stable string)
    action_type: Optional[str] = None  # existing ActionType value, or null


class PlatformComponentOut(BaseModel):
    id: str
    display_name: str
    description: str
    icon_key: str
    platforms: List[str]
    file_types: List[str]             # existing AgentFileType string values
    lifecycle: List[ComponentLifecycleOut]
    capabilities: List[str]


class PlatformComponentsResponse(BaseModel):
    schema_version: int = 1
    components: List[PlatformComponentOut]
