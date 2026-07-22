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
    # Optional execution timeout (seconds); validated to a sane range. Absent =
    # the queue's default (300s). Milestone 8 — timeout handling.
    timeout_seconds: Optional[int] = None
    # Request a policy override (Milestone 10). Only honored for an elevated
    # operator (owner/admin); ignored otherwise. Bypasses soft policy scopes only,
    # never the hard validation layer (capability/executability).
    override: bool = False


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


# --------------------------------------------------------------------------- #
# Component Action History (Operational — M7). Reuses the EXISTING remote_actions #
# store (no new table): each queued RemoteAction attributable to a component via  #
# the Lifecycle reverse index is surfaced with operation/user/timestamp/result/   #
# duration/device/component.                                                      #
# --------------------------------------------------------------------------- #
class ComponentActionHistoryItem(RemoteActionResponse):
    component_id: str   # attributed via the Lifecycle reverse index
    operation: str      # lifecycle operation the action implements
    label: str          # display label for the operation


class ComponentActionHistoryResponse(BaseModel):
    schema_version: int = 1
    device_id: int
    items: List[ComponentActionHistoryItem]


# --------------------------------------------------------------------------- #
# Bulk Component Actions (Operational — M9). Apply operations across multiple    #
# devices × multiple components; each item is queued independently through the   #
# existing pipeline, with per-item validation and partial-failure reporting.     #
# --------------------------------------------------------------------------- #
class BulkComponentActionTarget(BaseModel):
    component_id: str
    operation: str


class BulkComponentActionRequest(BaseModel):
    device_ids: List[int]
    targets: List[BulkComponentActionTarget]
    parameters: Optional[Dict[str, Any]] = None
    timeout_seconds: Optional[int] = None
    override: bool = False  # elevated-operator-only policy override (Milestone 10)


class BulkComponentActionItem(BaseModel):
    device_id: int
    component_id: str
    operation: str
    ok: bool
    action_id: Optional[int] = None
    action_type: Optional[str] = None
    status: Optional[str] = None
    error_code: Optional[str] = None   # stable code when ok is False
    error: Optional[str] = None


class BulkComponentActionResponse(BaseModel):
    schema_version: int = 1
    total: int
    succeeded: int
    failed: int
    items: List[BulkComponentActionItem]


# --------------------------------------------------------------------------- #
# Package Integration (Operational — M11). Read-only status: Installed / Desired #
# / Available versions + Outdated detection, per component on a device.          #
# --------------------------------------------------------------------------- #
class ComponentPackageStatusOut(BaseModel):
    schema_version: int = 1
    device_id: int
    component_id: str
    installed_version: Optional[str] = None
    desired_version: Optional[str] = None
    available_version: Optional[str] = None
    outdated: bool = False


# --------------------------------------------------------------------------- #
# Auto Remediation (Operational — M12). Detect an unhealthy component and, if     #
# policy allows, queue the recommended remediation via the existing action path. #
# --------------------------------------------------------------------------- #
class ComponentRemediationRequest(BaseModel):
    dry_run: bool = False   # detect + recommend only, never queue


class ComponentRemediationResponse(BaseModel):
    schema_version: int = 1
    device_id: int
    component_id: str
    operation: Optional[str] = None    # recommended remediation op, or null
    acted: bool = False                # whether an action was queued
    reason: str                        # queued | healthy | dry_run | <error/gate code>
    installed_version: Optional[str] = None
    desired_version: Optional[str] = None
    available_version: Optional[str] = None
    outdated: bool = False
    action: Optional[RemoteActionResponse] = None
    error: Optional[str] = None
