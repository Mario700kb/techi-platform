"""Component Action Telemetry (Platform Components — Operational, Milestone 13).

Read-only aggregation over the EXISTING ``remote_actions`` store — no new storage,
no counters to keep in sync. It reuses the same attribution seam as History
(``ComponentActionService.attribute`` / the Lifecycle reverse index) to group the
device's actions by component and operation, then derives:

  * **Metrics**            — total, succeeded, failed, in-progress, cancelled counts
  * **Failures**           — the failed count (failed/expired)
  * **Success rate**       — succeeded / (succeeded + failed), or None when neither
  * **Duration**           — average wall-clock seconds over completed actions
  * **Operation statistics** — the same metrics broken down per lifecycle operation

Everything is computed on the fly from the action rows the queue already writes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.remote_action import ActionStatus, RemoteAction
from app.services.component_action_service import ComponentActionService
from app.services.remote_action_service import RemoteActionService

_SUCCESS = {ActionStatus.COMPLETED}
_FAILED = {ActionStatus.FAILED, ActionStatus.EXPIRED}
_IN_PROGRESS = {ActionStatus.QUEUED, ActionStatus.SENT, ActionStatus.ACKNOWLEDGED, ActionStatus.RUNNING}
_CANCELLED = {ActionStatus.CANCELLED}


@dataclass
class _Accumulator:
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    in_progress: int = 0
    cancelled: int = 0
    _durations: List[float] = field(default_factory=list)

    def add(self, action: RemoteAction) -> None:
        self.total += 1
        status = action.status
        if status in _SUCCESS:
            self.succeeded += 1
        elif status in _FAILED:
            self.failed += 1
        elif status in _IN_PROGRESS:
            self.in_progress += 1
        elif status in _CANCELLED:
            self.cancelled += 1
        duration = _duration_seconds(action)
        if duration is not None:
            self._durations.append(duration)

    @property
    def success_rate(self) -> Optional[float]:
        denominator = self.succeeded + self.failed
        if denominator == 0:
            return None
        return round(self.succeeded / denominator, 4)

    @property
    def avg_duration_seconds(self) -> Optional[float]:
        if not self._durations:
            return None
        return round(sum(self._durations) / len(self._durations), 3)


def _duration_seconds(action: RemoteAction) -> Optional[float]:
    started = action.started_at
    end = action.completed_at or action.failed_at
    if started is None or end is None:
        return None
    return (end - started).total_seconds()


@dataclass(frozen=True)
class OperationMetrics:
    operation: str
    total: int
    succeeded: int
    failed: int
    in_progress: int
    cancelled: int
    success_rate: Optional[float]
    avg_duration_seconds: Optional[float]


@dataclass(frozen=True)
class ComponentMetrics:
    component_id: str
    total: int
    succeeded: int
    failed: int
    in_progress: int
    cancelled: int
    success_rate: Optional[float]
    avg_duration_seconds: Optional[float]
    operations: List[OperationMetrics]


def _metrics_from(acc: _Accumulator, **extra) -> dict:
    return dict(
        total=acc.total, succeeded=acc.succeeded, failed=acc.failed,
        in_progress=acc.in_progress, cancelled=acc.cancelled,
        success_rate=acc.success_rate, avg_duration_seconds=acc.avg_duration_seconds,
        **extra,
    )


class ComponentTelemetryService:
    def __init__(self, db: Session):
        self.db = db
        self._actions = RemoteActionService(db)

    def for_device(self, device_id: int, *, limit: int = 500) -> List[ComponentMetrics]:
        """Per-component telemetry for a device, each with per-operation breakdown.
        Aggregates the recent (up to ``limit``) attributable actions."""
        recent = self._actions.get_recent(device_id, limit=limit)
        by_component: Dict[str, _Accumulator] = {}
        by_operation: Dict[str, Dict[str, _Accumulator]] = {}

        for action in recent:
            attributed = ComponentActionService.attribute(action.action_type)
            if attributed is None:
                continue
            component_id, operation = attributed
            by_component.setdefault(component_id, _Accumulator()).add(action)
            by_operation.setdefault(component_id, {}).setdefault(operation, _Accumulator()).add(action)

        result: List[ComponentMetrics] = []
        for component_id, acc in by_component.items():
            operations = [
                OperationMetrics(operation=op, **_metrics_from(op_acc))
                for op, op_acc in sorted(by_operation.get(component_id, {}).items())
            ]
            result.append(ComponentMetrics(
                component_id=component_id, operations=operations, **_metrics_from(acc)
            ))
        result.sort(key=lambda m: m.component_id)
        return result
