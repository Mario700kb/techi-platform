"""Component Registry — the single source of truth for the deployable software
components TECHI manages on a device (Platform Components foundation).

This is an ABSTRACTION LAYER, not a replacement. It changes no production
contract: every existing ``file_type`` string, ``manifest.json`` entry, download
URL, self-update flow, bootstrap and NETLOGON path keeps working byte-identically.
The registry only *classifies* the pieces that already exist:

    Component  →  Packages (existing file_types)  →  Lifecycle (existing actions)
               →  Capabilities  →  Desired State (model only)

One ``ComponentDescriptor`` per component carries everything a registry-driven
consumer needs — mirroring how ``ActionDescriptor`` (actions.py) and
``PlatformDescriptor`` (registry.py) already work in this package:

  * classification — ``file_types`` (existing AgentFileType values, unchanged)
  * UI             — ``display_name``, ``icon_key``, ``description``, ``platforms``
  * lifecycle      — ``lifecycle`` maps a LifecycleOperation to the EXISTING
                     queued ActionType that already implements it (or None when
                     the mechanism is not a queued action, e.g. install via
                     GPO/NETLOGON, discover via heartbeat)
  * capabilities   — the capability tokens (KNOWN_CAPABILITIES) this component
                     relates to
  * desired state  — the ComponentState MODEL + a pure health derivation; NO
                     policy engine, NO auto-update, NO wiring (foundation only)

Design rule (mirrors the rest of platform_core): consumers ask this registry
"what components exist / which owns this file_type / what does it support",
never ``if remote_support`` / ``if agent`` branching. Adding a component later
(VPN, Printer Helper, ...) is one registry entry — not implemented here on
purpose; this phase ships the structure and classifies today's two components.

Foundation status: like the other platform_core registries were in Phase 0,
this module is imported by tests and re-exported from the package, but is NOT
yet wired into any service or endpoint — that is a later STOP (UI registry).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Dict, FrozenSet, List, Mapping, Optional, Tuple

from app.platform_core.capabilities import KNOWN_CAPABILITIES
from app.schemas.agent_package import AgentFileType
from app.schemas.remote_action import ActionType

# Pure domain layer: this module imports ONLY sibling registries and schema
# enums — never FastAPI, a DB session, settings I/O, services, or repositories.
# The version comparison used by desired-state health is therefore inlined below
# (a self-contained pure helper) rather than importing services.version_service.


class LifecycleOperation(str, Enum):
    """The lifecycle operations a component MAY support. A component declares
    which ones it supports (registry decides); none is mandatory."""

    INSTALL = "install"
    UPDATE = "update"
    REPAIR = "repair"
    RESTART = "restart"
    DISCOVER = "discover"
    SYNC = "sync"


class ComponentHealth(str, Enum):
    """Desired-state health of a component on a device (model only). Derived from
    the installed vs desired version — never auto-acted upon at this phase."""

    CURRENT = "current"      # installed == desired (or newer)
    OUTDATED = "outdated"    # installed older than desired
    MISSING = "missing"      # component not installed / no version reported
    UNKNOWN = "unknown"      # desired unknown, or versions unparseable


@dataclass(frozen=True)
class ComponentDescriptor:
    id: str
    display_name: str
    description: str
    icon_key: str
    # Platforms this component is deployable on (classification-driven; agent
    # platforms vs macOS Remote Support differ). Values are platform ids from
    # PLATFORM_REGISTRY.
    platforms: Tuple[str, ...]
    # EXISTING AgentFileType values this component owns. No string is invented
    # or renamed — the registry only groups what already exists.
    file_types: Tuple[AgentFileType, ...]
    # Supported lifecycle operations → the EXISTING queued ActionType that
    # implements each (or None when the mechanism is not a queued action, e.g.
    # install via GPO/NETLOGON, discover via heartbeat). A key present = the
    # component supports that operation; absent = it does not.
    lifecycle: Mapping[LifecycleOperation, Optional[ActionType]]
    # Capability tokens (KNOWN_CAPABILITIES) this component relates to. Empty for
    # the always-present native agent; {"remote_support"} for Remote Support.
    capabilities: FrozenSet[str] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        # Freeze the lifecycle mapping so a frozen descriptor cannot leak mutable
        # shared state (platforms/file_types/capabilities are already immutable
        # tuples/frozensets; lifecycle is passed as a dict literal).
        object.__setattr__(
            self, "lifecycle", MappingProxyType(dict(self.lifecycle))
        )

    @property
    def file_type_values(self) -> Tuple[str, ...]:
        return tuple(ft.value for ft in self.file_types)

    def supports(self, operation: LifecycleOperation) -> bool:
        return operation in self.lifecycle

    def handler_for(self, operation: LifecycleOperation) -> Optional[ActionType]:
        """The queued ActionType implementing an operation, or None when the
        operation is supported but not via a queued action (GPO/heartbeat)."""
        return self.lifecycle.get(operation)


# Ordered; UI renders in this order. Only today's two real components are
# declared — VPN / Printer Helper / etc. are intentionally NOT added here.
_COMPONENTS: Tuple[ComponentDescriptor, ...] = (
    ComponentDescriptor(
        id="agent",
        display_name="TECHI Agent",
        description=(
            "The TECHI monitoring/management agent (Windows service / Linux "
            "daemon): heartbeat, remote actions, and script-free self-update."
        ),
        icon_key="agent",
        platforms=("windows", "linux"),
        # `msi` is historically the combined package but current Windows
        # deployment treats it as Agent-only (see AgentFileType.MSI docstring).
        file_types=(
            AgentFileType.MSI,
            AgentFileType.AGENT_BINARY,
            AgentFileType.AGENT_UPDATE_MSI,
        ),
        lifecycle={
            # First install is GPO/NETLOGON bootstrap — not a queued action.
            LifecycleOperation.INSTALL: None,
            LifecycleOperation.UPDATE: ActionType.SELF_UPDATE,
            LifecycleOperation.RESTART: ActionType.RESTART_AGENT,
            # Discovery is via the heartbeat (agent_version/agent_sha256).
            LifecycleOperation.DISCOVER: None,
        },
        capabilities=frozenset(),  # native agent — always present, no gate
    ),
    ComponentDescriptor(
        id="remote_support",
        display_name="TECHI Remote Support",
        description=(
            "Branded RustDesk remote-desktop client, versioned and deployed "
            "independently of the Agent. The Agent observes and manages it."
        ),
        icon_key="remote_support",
        platforms=("windows", "darwin"),
        file_types=(
            AgentFileType.REMOTE_SUPPORT_MSI,
            AgentFileType.REMOTE_SUPPORT_BUNDLE,
            AgentFileType.REMOTE_SUPPORT_DMG,
            AgentFileType.REMOTE_SUPPORT_PKG,
        ),
        lifecycle={
            LifecycleOperation.INSTALL: ActionType.DEPLOY_REMOTE_SUPPORT,
            LifecycleOperation.UPDATE: ActionType.DEPLOY_REMOTE_SUPPORT,
            LifecycleOperation.REPAIR: ActionType.REPAIR_CONFIG_RUSTDESK,
            LifecycleOperation.RESTART: ActionType.RESTART_RUSTDESK,
            LifecycleOperation.SYNC: ActionType.SYNC_RUSTDESK,
            # Discovery is via the heartbeat's rustdesk_* fields.
            LifecycleOperation.DISCOVER: None,
        },
        capabilities=frozenset({"remote_support"}),
    ),
)

COMPONENT_REGISTRY: Dict[str, ComponentDescriptor] = {c.id: c for c in _COMPONENTS}

# Reverse index: every file_type is owned by exactly one component. Built here so
# a duplicate/overlapping claim raises at import time (a contract test also
# asserts full, non-overlapping coverage of AgentFileType).
_FILE_TYPE_OWNER: Dict[str, ComponentDescriptor] = {}
for _component in _COMPONENTS:
    for _ft in _component.file_types:
        if _ft.value in _FILE_TYPE_OWNER:
            raise ValueError(
                f"file_type '{_ft.value}' claimed by both "
                f"'{_FILE_TYPE_OWNER[_ft.value].id}' and '{_component.id}'"
            )
        _FILE_TYPE_OWNER[_ft.value] = _component

# Every declared capability must exist in the controlled vocabulary (same guard
# the Platform Registry applies to its allowed_capabilities).
for _component in _COMPONENTS:
    _unknown = _component.capabilities - KNOWN_CAPABILITIES
    if _unknown:
        raise ValueError(
            f"Component '{_component.id}' declares unknown capabilities: {sorted(_unknown)}"
        )


def list_components() -> List[ComponentDescriptor]:
    """All components in registry order."""
    return list(_COMPONENTS)


def get_component(component_id: Optional[str]) -> Optional[ComponentDescriptor]:
    if not component_id:
        return None
    return COMPONENT_REGISTRY.get(str(component_id).strip().lower())


def component_for_file_type(file_type: Optional[str]) -> Optional[ComponentDescriptor]:
    """The component that owns an existing file_type value, or None if unknown.
    This is the classification bridge — it maps the UNCHANGED file_type strings
    onto components without touching them."""
    if not file_type:
        return None
    return _FILE_TYPE_OWNER.get(str(file_type).strip().lower())


def list_file_types_for_component(component_id: Optional[str]) -> List[str]:
    """The existing file_type string values a component owns, or [] if unknown."""
    component = get_component(component_id)
    return list(component.file_type_values) if component else []


def components_for_platform(platform_id: Optional[str]) -> List[ComponentDescriptor]:
    """Components deployable on a platform (absence ⇒ windows, the reference
    platform, matching the rest of platform_core)."""
    pid = (platform_id or "windows").strip().lower() or "windows"
    return [c for c in _COMPONENTS if pid in c.platforms]


# --------------------------------------------------------------------------- #
# Desired State — MODEL ONLY. No policy engine, no auto-update, no wiring.      #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ComponentState:
    """A component's desired-state snapshot on one device. The caller supplies
    the observed installed_version and the desired_version (this phase does NOT
    compute desired from policy — that is a later phase); health is derived
    purely from the two."""

    component_id: str
    installed_version: Optional[str]
    desired_version: Optional[str]
    health: ComponentHealth


def _parse_version(value: str) -> Optional[tuple]:
    """Parse a dotted numeric version to a tuple, or None if unparseable.
    Mirrors the semantics of services.version_service._parse without importing it
    (keeps this module a pure domain layer)."""
    try:
        return tuple(int(p) for p in value.strip().lstrip("vV").split("."))
    except (ValueError, AttributeError):
        return None


def derive_health(
    installed_version: Optional[str], desired_version: Optional[str]
) -> ComponentHealth:
    """Pure, self-contained health derivation (no I/O, no services):

      * no installed AND no desired         -> UNKNOWN (nothing to compare)
      * no installed, desired present       -> MISSING (expected but absent)
      * installed present, no desired        -> UNKNOWN (nothing to compare against)
      * either version unparseable           -> UNKNOWN (fail-closed, never guess)
      * installed older than desired         -> OUTDATED
      * installed equal to desired           -> CURRENT
      * installed newer than desired ("ahead") -> CURRENT (a device is not "behind";
        a documented, deliberate fold at this foundation phase — no AHEAD state)
    """
    installed = (installed_version or "").strip()
    desired = (desired_version or "").strip()
    if not installed:
        return ComponentHealth.MISSING if desired else ComponentHealth.UNKNOWN
    if not desired:
        return ComponentHealth.UNKNOWN
    if installed == desired:
        return ComponentHealth.CURRENT
    iv, dv = _parse_version(installed), _parse_version(desired)
    if iv is None or dv is None:
        return ComponentHealth.UNKNOWN
    if iv == dv:
        return ComponentHealth.CURRENT
    return ComponentHealth.OUTDATED if iv < dv else ComponentHealth.CURRENT


def build_component_state(
    component_id: str,
    installed_version: Optional[str],
    desired_version: Optional[str],
) -> ComponentState:
    """Assemble a ComponentState from observed inputs (model only)."""
    return ComponentState(
        component_id=component_id,
        installed_version=(installed_version or None),
        desired_version=(desired_version or None),
        health=derive_health(installed_version, desired_version),
    )
