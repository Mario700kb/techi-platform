"""Component Action Service — executes a component lifecycle operation by
resolving it (Milestone 1) and queuing it through the EXISTING device-action
pipeline (Platform Components — Operational, Milestone 2).

This is deliberately thin: it is the seam between the pure resolver and the
unchanged ``RemoteActionService.queue_action``. It creates NO parallel queue and
NO new execution path — every component action becomes an ordinary
``RemoteAction`` of an existing ``ActionType``, delivered on the next heartbeat
exactly like any other action. The service only:

  1. resolves ``(component, operation)`` to an existing ``ActionType`` + payload
     (raises :class:`ComponentActionError` with a stable code on any failure);
  2. checks the resolved action is actually available for THIS device (its
     platform + effective capabilities) — so a component action can never queue
     something the device cannot perform;
  3. queues it via the existing pipeline (conflict/duplicate guard included).

Permission enforcement stays at the endpoint (mirroring ``queue_device_action``),
driven by the same ``ACTION_PERMISSION_MAP``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.models.remote_action import RemoteAction
from app.platform_core.action_resolver import (
    ComponentActionError,
    ComponentActionErrorCode,
    ResolvedComponentAction,
    resolve_component_action,
)
from app.platform_core.actions import actions_for
from app.schemas.remote_action import RemoteActionCreate
from app.services.remote_action_service import RemoteActionService


@dataclass(frozen=True)
class ComponentActionResult:
    """A queued component action plus the resolution metadata that produced it."""

    resolved: ResolvedComponentAction
    action: RemoteAction


def _available_action_ids(device: Device) -> frozenset:
    """The action ids available for a device given its platform + capabilities.
    Reuses the Action Registry's capability-driven availability (the same source
    the Device Drawer uses) — no separate gating logic."""
    return frozenset(
        descriptor.id
        for descriptor in actions_for(device.platform, device.capabilities)
    )


class ComponentActionService:
    def __init__(self, db: Session):
        self.db = db
        self._actions = RemoteActionService(db)

    def resolve_for_device(
        self,
        device: Device,
        component_id: str,
        operation: Any,
        *,
        parameters: Optional[Mapping[str, Any]] = None,
    ) -> ResolvedComponentAction:
        """Resolve + device-availability check, without queuing. Raises
        :class:`ComponentActionError` (stable code) on any failure."""
        resolved = resolve_component_action(
            component_id, operation, parameters=parameters
        )
        if resolved.action_type.value not in _available_action_ids(device):
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
        return resolved

    def execute(
        self,
        device: Device,
        component_id: str,
        operation: Any,
        *,
        created_by: Optional[str],
        parameters: Optional[Mapping[str, Any]] = None,
    ) -> ComponentActionResult:
        """Resolve, validate device availability, and queue the action through
        the existing pipeline. Raises :class:`ComponentActionError` on resolution/
        availability failure and ``ValueError`` on a queue conflict/duplicate."""
        resolved = self.resolve_for_device(
            device, component_id, operation, parameters=parameters
        )
        create_in = RemoteActionCreate(
            action_type=resolved.action_type,
            parameters=dict(resolved.payload) or None,
            created_by=created_by,
        )
        action = self._actions.queue_action(device.id, create_in)
        return ComponentActionResult(resolved=resolved, action=action)
