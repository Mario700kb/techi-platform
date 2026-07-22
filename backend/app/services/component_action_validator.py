"""Component Action Validator — the single, ordered validation layer for a
component lifecycle operation (Platform Components — Operational, Milestone 3).

Every check that decides *whether a component action may be queued* lives here,
run in a fixed order, each raising a :class:`ComponentActionError` with a stable
``code``. Centralizing them means there is exactly one place to reason about
validity — no ``if component == ...`` / ``if operation == ...`` checks scattered
across the endpoint and service.

Checks (in order):

  1. **component / operation / executability** — delegated to the pure resolver
     (``resolve_component_action``): the component must exist, the operation must
     be a real, *supported*, *queueable* lifecycle operation.
  2. **device capability** — the resolved ``ActionType`` must be available for the
     device's platform + effective capabilities (reusing ``actions_for`` — the
     same source the Device Drawer uses).
  3. **policy** — the component must have a declared deployment policy
     (``policy_for``); a component with none is a modelling error, refused.
  4. **version format** — if the caller supplies a ``version`` parameter, it must
     be a parseable dotted-numeric version.

Deliberately *out of scope here* (they get their own milestones and would make
this layer depend on the file-based package manifest, which is non-deterministic):

  * package availability / desired-version resolution / outdated detection → M11;
  * policy *enforcement* beyond "a policy exists" (rollout/canary/override) → M10.

This validator is the seam those milestones extend — they add checks here, never
a parallel gate.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.platform_core.action_resolver import (
    ComponentActionError,
    ComponentActionErrorCode,
    ResolvedComponentAction,
    resolve_component_action,
)
from app.platform_core.actions import actions_for
from app.platform_core.policy import policy_for


def _parse_version(value: str) -> Optional[tuple]:
    """Parse a dotted-numeric version to a tuple, or None if unparseable (mirrors
    the pure derivation in components.py — kept local, no import of a private)."""
    try:
        return tuple(int(p) for p in value.strip().lstrip("vV").split("."))
    except (ValueError, AttributeError):
        return None


class ComponentActionValidator:
    """Runs the ordered validation checks for a component action. Stateless apart
    from the DB session it is constructed with (reserved for later milestones)."""

    def __init__(self, db: Session):
        self.db = db

    def validate(
        self,
        device: Device,
        component_id: str,
        operation: Any,
        *,
        parameters: Optional[Mapping[str, Any]] = None,
    ) -> ResolvedComponentAction:
        """Validate and return the resolved action, or raise
        :class:`ComponentActionError` with a stable code on the first failure."""
        # 1. component / operation / executability (pure resolver).
        resolved = resolve_component_action(
            component_id, operation, parameters=parameters
        )

        # 2. device capability / platform availability.
        self._check_device_available(device, resolved)

        # 3. policy present.
        self._check_policy(resolved)

        # 4. supplied version format.
        self._check_version_parameter(resolved, parameters)

        return resolved

    # ------------------------------------------------------------------ #
    # Individual checks                                                    #
    # ------------------------------------------------------------------ #
    def _check_device_available(
        self, device: Device, resolved: ResolvedComponentAction
    ) -> None:
        available = {
            descriptor.id
            for descriptor in actions_for(device.platform, device.capabilities)
        }
        if resolved.action_type.value not in available:
            raise ComponentActionError(
                ComponentActionErrorCode.UNAVAILABLE_FOR_DEVICE,
                (
                    f"Operation '{resolved.operation.value}' on component "
                    f"'{resolved.component_id}' is not available for this device "
                    "(platform/capabilities do not support it)."
                ),
                component_id=resolved.component_id,
                operation=resolved.operation.value,
            )

    def _check_policy(self, resolved: ResolvedComponentAction) -> None:
        if policy_for(resolved.component_id) is None:
            raise ComponentActionError(
                ComponentActionErrorCode.NO_POLICY,
                f"Component '{resolved.component_id}' has no deployment policy.",
                component_id=resolved.component_id,
                operation=resolved.operation.value,
            )

    def _check_version_parameter(
        self,
        resolved: ResolvedComponentAction,
        parameters: Optional[Mapping[str, Any]],
    ) -> None:
        if not parameters:
            return
        version = parameters.get("version")
        if version in (None, ""):
            return
        if _parse_version(str(version)) is None:
            raise ComponentActionError(
                ComponentActionErrorCode.INVALID_VERSION,
                f"Version '{version}' is not a valid dotted-numeric version.",
                component_id=resolved.component_id,
                operation=resolved.operation.value,
            )
