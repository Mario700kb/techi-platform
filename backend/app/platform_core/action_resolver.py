"""Component Action Resolver — the single seam that turns a
``(component, lifecycle operation)`` request into a concrete, queueable device
action (Platform Components — Operational, Milestone 1).

    Component  →  LifecycleOperation  →  ActionType  →  payload  →  Device Action

This is a PURE domain layer (mirrors the rest of ``platform_core``): it imports
only sibling registries and schema enums — never FastAPI, a DB session, settings
I/O, services, or repositories. It creates NO new ActionType, NO parallel queue,
and NO source of truth. It only *resolves*: given a component id and an operation,
it consults the existing Component/Lifecycle registries and returns the EXISTING
``ActionType`` plus a base payload the execution layer (Milestone 4) will queue
through the unchanged ``RemoteActionService.queue_action`` pipeline.

Resolution outcomes are explicit and structured — consumers never branch on
``if component == "agent"``:

  * a resolvable operation → a :class:`ResolvedComponentAction` (component,
    operation, ActionType, label, payload)
  * anything else → a :class:`ComponentActionError` carrying a stable
    :class:`ComponentActionErrorCode` so the API layer can map it to a precise
    HTTP status with a machine-readable ``code``.

Out-of-band operations (Agent install via GPO/NETLOGON, discovery via the
heartbeat — ``action_type is None`` in the Lifecycle Registry) are *supported
concepts* but are NOT queueable actions, so resolving them fails closed with
``NOT_EXECUTABLE`` rather than silently inventing an action.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Mapping, Optional

from app.platform_core.components import (
    LifecycleOperation,
    get_component,
)
from app.platform_core.lifecycle import LIFECYCLE_LABELS, action_for
from app.schemas.remote_action import ActionType


class ComponentActionErrorCode(str, Enum):
    """Stable, machine-readable reasons a component action cannot be resolved.
    The API layer maps each to an HTTP status; the string values are contract."""

    UNKNOWN_COMPONENT = "unknown_component"      # no such component in the registry
    UNKNOWN_OPERATION = "unknown_operation"      # not a LifecycleOperation value
    UNSUPPORTED_OPERATION = "unsupported_operation"  # component doesn't declare it
    NOT_EXECUTABLE = "not_executable"            # supported, but out-of-band (no queued action)
    # Resolvable in the abstract, but not available for THIS device's platform /
    # effective capabilities. Raised by the service layer, not the pure resolver.
    UNAVAILABLE_FOR_DEVICE = "unavailable_for_device"
    # Validation-layer (Milestone 3) codes — raised by ComponentActionValidator.
    NO_POLICY = "no_policy"                # component has no deployment policy
    INVALID_VERSION = "invalid_version"    # a supplied version parameter is malformed
    INVALID_TIMEOUT = "invalid_timeout"    # a supplied execution timeout is out of range
    # Retry (Milestone 8): the action being retried is not owned by any component.
    NOT_A_COMPONENT_ACTION = "not_a_component_action"
    # Policy enforcement (Milestone 10): denied by global/tenant/component policy.
    POLICY_DENIED = "policy_denied"


class ComponentActionError(Exception):
    """A component action could not be resolved to a queueable device action.

    Carries a stable ``code`` (:class:`ComponentActionErrorCode`) alongside a
    human-readable message so both machines and operators get a precise reason.
    """

    def __init__(
        self,
        code: ComponentActionErrorCode,
        message: str,
        *,
        component_id: Optional[str] = None,
        operation: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.component_id = component_id
        self.operation = operation


@dataclass(frozen=True)
class ResolvedComponentAction:
    """A fully resolved component action, ready for the execution layer to queue.

    ``payload`` is the base parameter dict carried through to
    ``RemoteActionService.queue_action`` unchanged. The resolver only passes the
    operator-supplied parameters through (plus nothing implicit) — later
    milestones (Package Integration) enrich it via explicit, tested seams, never
    by mutating agent contract here.
    """

    component_id: str
    operation: LifecycleOperation
    action_type: ActionType
    label: str
    payload: Mapping[str, Any] = field(default_factory=dict)


def parse_operation(value: Any) -> LifecycleOperation:
    """Coerce an operation string (or enum) to a :class:`LifecycleOperation`.

    Raises :class:`ComponentActionError` with ``UNKNOWN_OPERATION`` for anything
    that is not a valid lifecycle operation — so the API surfaces a 400 with a
    stable code instead of a bare ``ValueError``.
    """
    if isinstance(value, LifecycleOperation):
        return value
    try:
        return LifecycleOperation(str(value).strip().lower())
    except ValueError:
        valid = ", ".join(op.value for op in LifecycleOperation)
        raise ComponentActionError(
            ComponentActionErrorCode.UNKNOWN_OPERATION,
            f"Unknown lifecycle operation '{value}'. Valid operations: {valid}.",
            operation=str(value),
        )


def resolve_component_action(
    component_id: str,
    operation: Any,
    *,
    parameters: Optional[Mapping[str, Any]] = None,
) -> ResolvedComponentAction:
    """Resolve ``(component, operation)`` to a queueable device action.

    The single mapping path — component branching lives nowhere else:

      1. the component must exist in the Component Registry;
      2. the operation must be a valid :class:`LifecycleOperation`;
      3. the component must *declare* that operation;
      4. that operation must map to a real, queued ``ActionType`` (not out of
         band).

    Any failure raises :class:`ComponentActionError` with a stable code. On
    success returns a :class:`ResolvedComponentAction` carrying the existing
    ``ActionType`` and a base payload (the passed-through parameters).
    """
    component = get_component(component_id)
    if component is None:
        raise ComponentActionError(
            ComponentActionErrorCode.UNKNOWN_COMPONENT,
            f"Unknown component '{component_id}'.",
            component_id=str(component_id),
        )

    op = parse_operation(operation)

    if not component.supports(op):
        raise ComponentActionError(
            ComponentActionErrorCode.UNSUPPORTED_OPERATION,
            f"Component '{component.id}' does not support operation '{op.value}'.",
            component_id=component.id,
            operation=op.value,
        )

    action_type = action_for(component.id, op)
    if action_type is None:
        # Supported concept, but handled outside the action queue (GPO install,
        # heartbeat discovery). Fail closed — never fabricate an action.
        raise ComponentActionError(
            ComponentActionErrorCode.NOT_EXECUTABLE,
            (
                f"Operation '{op.value}' on component '{component.id}' is handled "
                "out of band (not via the action queue) and cannot be triggered here."
            ),
            component_id=component.id,
            operation=op.value,
        )

    return ResolvedComponentAction(
        component_id=component.id,
        operation=op,
        action_type=action_type,
        label=LIFECYCLE_LABELS[op],
        payload=dict(parameters or {}),
    )


def can_resolve(component_id: str, operation: Any) -> bool:
    """True iff ``(component, operation)`` resolves to a queueable device action.
    Never raises — a convenience for callers that only need a yes/no (e.g. the UI
    availability check), built on the same single resolution path."""
    try:
        resolve_component_action(component_id, operation)
        return True
    except ComponentActionError:
        return False
