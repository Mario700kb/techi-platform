"""Read-only response schema for the Platform Components registry endpoint.

Exposes ONLY stable strings (never a Python enum repr). Additive + versioned:
`schema_version` lets the frontend evolve backward-compatibly, and new optional
fields can be added without breaking older clients.
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from app.schemas.remote_action import RemoteActionResponse


class ComponentLifecycleOut(BaseModel):
    operation: str                    # LifecycleOperation value (stable string)
    label: str                        # display label (Install/Update/…)
    action_type: Optional[str] = None  # existing ActionType value, or null
    kind: str                         # "action" | "out_of_band"


class ComponentPolicyOut(BaseModel):
    # Declarative deployment-policy model (Phase 5) — metadata only, no execution.
    desired_source: str   # active_package | manual | none
    policy: str           # active_package | manual | future
    strategy: str         # manual | future


class PlatformComponentOut(BaseModel):
    id: str
    display_name: str
    description: str
    icon_key: str
    platforms: List[str]
    file_types: List[str]             # existing AgentFileType string values
    lifecycle: List[ComponentLifecycleOut]
    capabilities: List[str]
    policy: ComponentPolicyOut


class PlatformComponentsResponse(BaseModel):
    schema_version: int = 1
    components: List[PlatformComponentOut]


# Per-device Desired-State (foundation, read-only). Informational only — no
# enforcement, no auto-update.
class DeviceComponentStateOut(BaseModel):
    component_id: str
    display_name: str
    icon_key: str
    installed_version: Optional[str] = None
    desired_version: Optional[str] = None
    health: str    # current | outdated | missing | unknown (machine)
    status: str    # Current | Outdated | Missing | Unknown (display label)


class DeviceComponentStatesResponse(BaseModel):
    schema_version: int = 1
    device_id: int
    components: List[DeviceComponentStateOut]


# --------------------------------------------------------------------------- #
# Component Action API (Operational — Milestones 2/4). A component lifecycle    #
# operation is triggered here and queued through the EXISTING action pipeline;  #
# the response carries the resolution metadata + the queued RemoteAction.       #
# --------------------------------------------------------------------------- #
class ComponentActionRequest(BaseModel):
    # The lifecycle operation to trigger: install | update | reinstall | repair
    # | restart | discover | sync. Validated by the resolver (stable error codes).
    operation: str
    parameters: Optional[Dict[str, Any]] = None


class ComponentActionAccepted(BaseModel):
    """A successfully queued component action + how it was resolved."""

    component_id: str
    operation: str
    action_type: str   # the existing ActionType the operation mapped to
    label: str
    action: RemoteActionResponse


class ComponentActionErrorOut(BaseModel):
    """Structured error body for a rejected component action (stable ``code``)."""

    code: str          # ComponentActionErrorCode value
    detail: str
    component_id: Optional[str] = None
    operation: Optional[str] = None
