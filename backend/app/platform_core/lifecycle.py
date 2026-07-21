"""Lifecycle Registry — metadata, mapping, and validation over the lifecycle a
component declares (Platform Components Phase 4).

This is an abstraction layer, NOT a new source of truth and NOT an executor. The
declarations live where they already are — each `ComponentDescriptor.lifecycle`
(components.py) maps a `LifecycleOperation` to an EXISTING queued `ActionType`
(or `None` when the operation is handled out of band, e.g. GPO/NETLOGON install,
heartbeat-based discovery). This module reads those declarations and exposes:

  * metadata  — a stable label + a `kind` (action vs out-of-band) per operation
  * mapping   — operation → existing ActionType, and the reverse (action → the
                component + operation it implements)
  * validation — every mapped handler is a real, registered action; every
                declared operation is one the component actually supports

It creates no ActionType, no endpoint that executes lifecycle, no migration, and
touches no production contract. Consumers query the registry — never
`if component == "agent"` / `if component == "remote_support"`.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Mapping, Optional, Tuple
from types import MappingProxyType

from app.platform_core.actions import ACTION_REGISTRY
from app.platform_core.components import (
    LifecycleOperation,
    get_component,
    list_components,
)
from app.schemas.remote_action import ActionType


class LifecycleKind(str, Enum):
    """How a supported lifecycle operation is carried out."""

    # Executed through the existing queued-action pipeline (has an ActionType).
    ACTION = "action"
    # Supported concept handled OUTSIDE the queue (handler is None) — e.g. Agent
    # install via GPO/NETLOGON, discovery via the heartbeat. Declared for
    # completeness; this registry never executes it.
    OUT_OF_BAND = "out_of_band"


# Stable UI-facing labels per operation. Presentation only — no behavior.
LIFECYCLE_LABELS: Mapping[LifecycleOperation, str] = MappingProxyType(
    {
        LifecycleOperation.INSTALL: "Install",
        LifecycleOperation.UPDATE: "Update",
        LifecycleOperation.REINSTALL: "Reinstall",
        LifecycleOperation.REPAIR: "Repair",
        LifecycleOperation.RESTART: "Restart",
        LifecycleOperation.DISCOVER: "Discover",
        LifecycleOperation.SYNC: "Sync",
    }
)


@dataclass(frozen=True)
class LifecycleEntry:
    operation: LifecycleOperation
    label: str
    action_type: Optional[ActionType]  # existing ActionType, or None (out of band)
    kind: LifecycleKind


def _entry(operation: LifecycleOperation, action_type: Optional[ActionType]) -> LifecycleEntry:
    return LifecycleEntry(
        operation=operation,
        label=LIFECYCLE_LABELS[operation],
        action_type=action_type,
        kind=LifecycleKind.ACTION if action_type is not None else LifecycleKind.OUT_OF_BAND,
    )


def lifecycle_for(component_id: str) -> List[LifecycleEntry]:
    """The lifecycle metadata a component supports, in canonical operation order.
    Empty list for an unknown component (fail-soft, like the other registries)."""
    component = get_component(component_id)
    if component is None:
        return []
    return [
        _entry(operation, component.handler_for(operation))
        for operation in LifecycleOperation
        if component.supports(operation)
    ]


def operations_for(component_id: str) -> List[LifecycleOperation]:
    """The lifecycle operations a component supports, in canonical order."""
    return [entry.operation for entry in lifecycle_for(component_id)]


def action_for(component_id: str, operation: LifecycleOperation) -> Optional[ActionType]:
    """The existing ActionType that implements an operation for a component, or
    None (unsupported operation, or a supported out-of-band one)."""
    component = get_component(component_id)
    if component is None or not component.supports(operation):
        return None
    return component.handler_for(operation)


# Reverse index: an ActionType → the (component_id, operation) it implements.
# Built once; a contract test asserts each action maps back to exactly one seam.
_ACTION_TO_LIFECYCLE: Dict[str, Tuple[str, LifecycleOperation]] = {}
for _component in list_components():
    for _operation in LifecycleOperation:
        if not _component.supports(_operation):
            continue
        _handler = _component.handler_for(_operation)
        if _handler is None:
            continue
        # A given ActionType may legitimately back more than one operation of the
        # SAME component (e.g. Remote Support install/update both deploy). Only a
        # cross-component collision would be a modelling error.
        _existing = _ACTION_TO_LIFECYCLE.get(_handler.value)
        if _existing is not None and _existing[0] != _component.id:
            raise ValueError(
                f"ActionType '{_handler.value}' is claimed by two components: "
                f"'{_existing[0]}' and '{_component.id}'"
            )
        if _existing is None:
            _ACTION_TO_LIFECYCLE[_handler.value] = (_component.id, _operation)

ACTION_TO_LIFECYCLE: Mapping[str, Tuple[str, LifecycleOperation]] = MappingProxyType(
    _ACTION_TO_LIFECYCLE
)


def component_operation_for_action(
    action_type: Optional[str],
) -> Optional[Tuple[str, LifecycleOperation]]:
    """Reverse lookup: which (component_id, operation) an ActionType implements."""
    if not action_type:
        return None
    key = action_type.value if isinstance(action_type, ActionType) else str(action_type)
    return ACTION_TO_LIFECYCLE.get(key)


def validate_lifecycle_registry() -> None:
    """Fail-closed validation of the lifecycle mapping. Raises ValueError on:
      * a mapped handler that is not a registered action;
      * a mapped handler whose id != its ActionType value;
      * a missing display label for a supported operation.
    Run at import so a bad descriptor edit fails fast (mirrors the other
    platform_core registries' import-time guards)."""
    for component in list_components():
        for operation in LifecycleOperation:
            if not component.supports(operation):
                continue
            if operation not in LIFECYCLE_LABELS:
                raise ValueError(f"Lifecycle operation '{operation}' has no display label")
            handler = component.handler_for(operation)
            if handler is None:
                continue
            if handler.value not in ACTION_REGISTRY:
                raise ValueError(
                    f"Component '{component.id}' lifecycle '{operation.value}' maps to "
                    f"unknown action '{handler.value}'"
                )
            if ACTION_REGISTRY[handler.value].handler.value != handler.value:
                raise ValueError(
                    f"Action '{handler.value}' handler mismatch in the Action Registry"
                )


validate_lifecycle_registry()
