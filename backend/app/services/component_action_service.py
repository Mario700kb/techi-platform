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
from typing import Any, Mapping, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.device import Device
from app.models.remote_action import RemoteAction
from app.platform_core.action_resolver import ResolvedComponentAction
from app.platform_core.lifecycle import component_operation_for_action
from app.schemas.remote_action import RemoteActionCreate
from app.services.component_action_validator import ComponentActionValidator
from app.services.remote_action_service import RemoteActionService


@dataclass(frozen=True)
class ComponentActionResult:
    """A queued component action plus the resolution metadata that produced it."""

    resolved: ResolvedComponentAction
    action: RemoteAction


class ComponentActionService:
    def __init__(self, db: Session):
        self.db = db
        self._actions = RemoteActionService(db)
        self._validator = ComponentActionValidator(db)

    def resolve_for_device(
        self,
        device: Device,
        component_id: str,
        operation: Any,
        *,
        parameters: Optional[Mapping[str, Any]] = None,
    ) -> ResolvedComponentAction:
        """Run the full validation layer (Milestone 3) without queuing. Raises
        :class:`ComponentActionError` (stable code) on the first failure."""
        return self._validator.validate(
            device, component_id, operation, parameters=parameters
        )

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

    @staticmethod
    def attribute(action_type: Optional[str]) -> Optional[Tuple[str, str]]:
        """Reverse seam (Milestone 4): map an EXISTING queued action back to the
        ``(component_id, operation)`` it implements, via the Lifecycle Registry's
        reverse index — so any ``RemoteAction`` (however it was queued: this
        endpoint, Command Center, the RS flow) can be attributed to a component
        for history/telemetry. Reuses the existing index; introduces no new store.

        Returns ``None`` for actions not owned by any component (e.g. ``ping``).
        A shared action resolves to its first declared operation (documented fold
        in the Lifecycle Registry).
        """
        result = component_operation_for_action(action_type)
        if result is None:
            return None
        component_id, operation = result
        return component_id, operation.value
