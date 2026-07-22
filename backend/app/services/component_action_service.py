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
from app.platform_core.action_resolver import (
    ComponentActionError,
    ComponentActionErrorCode,
    ResolvedComponentAction,
)
from app.platform_core.components import LifecycleOperation
from app.platform_core.lifecycle import LIFECYCLE_LABELS, component_operation_for_action
from app.schemas.remote_action import RemoteActionCreate
from app.services.component_action_validator import ComponentActionValidator
from app.services.remote_action_service import RemoteActionService


@dataclass(frozen=True)
class ComponentActionResult:
    """A queued component action plus the resolution metadata that produced it."""

    resolved: ResolvedComponentAction
    action: RemoteAction


@dataclass(frozen=True)
class ComponentActionHistoryEntry:
    """One historical component action: the existing RemoteAction plus its
    attributed component/operation/label. No new storage — the RemoteAction IS
    the record (operation via attribution, user=created_by, timestamp=created_at,
    result=result/error, duration derived, device=device_id)."""

    action: RemoteAction
    component_id: str
    operation: str
    label: str


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
        timeout_seconds: Optional[int] = None,
    ) -> ResolvedComponentAction:
        """Run the full validation layer (Milestone 3) without queuing. Raises
        :class:`ComponentActionError` (stable code) on the first failure."""
        return self._validator.validate(
            device, component_id, operation,
            parameters=parameters, timeout_seconds=timeout_seconds,
        )

    def execute(
        self,
        device: Device,
        component_id: str,
        operation: Any,
        *,
        created_by: Optional[str],
        parameters: Optional[Mapping[str, Any]] = None,
        timeout_seconds: Optional[int] = None,
    ) -> ComponentActionResult:
        """Resolve, validate device availability, and queue the action through
        the existing pipeline. Raises :class:`ComponentActionError` on resolution/
        availability failure and ``ValueError`` on a queue conflict/duplicate
        (the existing idempotency guard — no duplicate component actions)."""
        resolved = self.resolve_for_device(
            device, component_id, operation,
            parameters=parameters, timeout_seconds=timeout_seconds,
        )
        create_in = RemoteActionCreate(
            action_type=resolved.action_type,
            parameters=dict(resolved.payload) or None,
            created_by=created_by,
            execution_timeout_seconds=timeout_seconds,
        )
        action = self._actions.queue_action(device.id, create_in)
        return ComponentActionResult(resolved=resolved, action=action)

    def retry(
        self,
        device: Device,
        action: RemoteAction,
        *,
        created_by: Optional[str],
    ) -> ComponentActionResult:
        """Retry a terminal component action (Milestone 8), re-validating that the
        operation is STILL allowed for the device before re-queuing through the
        existing retry path. Raises :class:`ComponentActionError` if the action is
        not a component action or is no longer allowed, and ``ValueError`` if it is
        not in a terminal status (retry only when permitted) or would duplicate an
        active action (idempotency)."""
        attributed = self.attribute(action.action_type)
        if attributed is None:
            raise ComponentActionError(
                ComponentActionErrorCode.NOT_A_COMPONENT_ACTION,
                f"Action '{action.action_type}' is not a component action and cannot be retried here.",
            )
        component_id, operation = attributed
        # Re-validate against CURRENT device state (capabilities/policy may have
        # changed since the original was queued).
        resolved = self._validator.validate(
            device, component_id, operation, parameters=action.payload_dict or None
        )
        new_action = self._actions.retry_action(action.id, caller_username=created_by)
        return ComponentActionResult(resolved=resolved, action=new_action)

    def history(
        self,
        device_id: int,
        *,
        component_id: Optional[str] = None,
        limit: int = 30,
    ) -> list:
        """Recent component actions for a device, newest first (Milestone 7).

        Reuses the EXISTING remote_actions store: fetches recent RemoteActions and
        keeps only those attributable to a component (via the reverse index),
        optionally filtered to one component. No new table, no migration.
        """
        wanted = component_id.strip().lower() if component_id else None
        # Fetch a wider window than `limit` because the recent list is mixed with
        # non-component actions (ping, terminal, …) that we filter out.
        recent = self._actions.get_recent(device_id, limit=max(limit * 3, limit))
        entries = []
        for action in recent:
            attributed = self.attribute(action.action_type)
            if attributed is None:
                continue
            attr_component, operation = attributed
            if wanted is not None and attr_component != wanted:
                continue
            label = LIFECYCLE_LABELS.get(LifecycleOperation(operation), operation)
            entries.append(
                ComponentActionHistoryEntry(
                    action=action,
                    component_id=attr_component,
                    operation=operation,
                    label=label,
                )
            )
            if len(entries) >= limit:
                break
        return entries

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
