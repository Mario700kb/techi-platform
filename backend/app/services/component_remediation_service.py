"""Component Auto-Remediation (Platform Components — Operational, Milestone 12).

Detects an unhealthy component on a device and, *if policy allows*, remediates it
by queuing the appropriate lifecycle operation through the EXISTING action path
(``ComponentActionService.execute`` → the unchanged queue). It builds NO parallel
automation system and NO scheduler — rollout/scheduling stays "future" in the
STABLE Policy model. This module is the mechanism (detect + guarded remediate);
whoever triggers it (an operator button, or a future scheduler) calls in.

Detection is version/health driven (reusing the M11 Package Integration status):

  * **Outdated** (installed < desired) → **update**
  * **Missing** (not installed, desired known) → **install** (or **reinstall** when
    install is out of band, e.g. the Agent's GPO install)
  * healthy / unknown → no remediation

The chosen operation must be *supported and executable* for the component; a
missing Agent (install is GPO/out-of-band, no reinstall) yields **no** action —
auto-remediation never fabricates one.

Two gates:

  * **auto** runs (unattended) require ``AUTO_REMEDIATION`` policy to permit it
    (global + optional per-component), defaulting **off** — nothing self-heals
    silently until deliberately enabled.
  * **manual** runs (an operator explicitly asks to remediate) are subject to the
    normal validation + policy-enforcement (M10) + permission gate in
    ``execute`` — not to the auto gate.

Repair / Restart are valid remediation operations too; the current detector is
version-driven (update/install/reinstall). A runtime-health signal feeding
Repair/Restart is a later extension of this same detector — not a new system.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.models.remote_action import RemoteAction
from app.platform_core.action_resolver import ComponentActionError, can_resolve
from app.platform_core.components import LifecycleOperation, get_component
from app.services.component_action_service import ComponentActionService
from app.services.component_package_service import ComponentPackageService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AutoRemediationPolicy:
    enabled: bool = False


# Global default: OFF. Nothing self-heals unattended until deliberately enabled.
GLOBAL_AUTO_REMEDIATION = AutoRemediationPolicy(enabled=False)
# Optional per-component override (component_id → policy). Absent ⇒ inherit global.
COMPONENT_AUTO_REMEDIATION: Dict[str, AutoRemediationPolicy] = {}


def auto_remediation_allowed(component_id: str) -> bool:
    policy = COMPONENT_AUTO_REMEDIATION.get(component_id, GLOBAL_AUTO_REMEDIATION)
    return policy.enabled


# Priority of remediation operations per detected condition. First one that the
# component supports AND that resolves to an executable action wins.
_OUTDATED_OPS = ("update",)
_MISSING_OPS = ("install", "reinstall")


@dataclass(frozen=True)
class RemediationPlan:
    component_id: str
    operation: Optional[str]   # recommended op, or None when nothing to do / not possible
    reason: str                # outdated | missing | healthy | unknown_component | no_executable_remediation
    installed_version: Optional[str] = None
    desired_version: Optional[str] = None
    available_version: Optional[str] = None
    outdated: bool = False


@dataclass(frozen=True)
class RemediationResult:
    plan: RemediationPlan
    acted: bool
    reason: str                # queued | healthy | dry_run | auto_remediation_disabled | <error code>
    action: Optional[RemoteAction] = None
    error: Optional[str] = None


class ComponentRemediationService:
    def __init__(self, db: Session):
        self.db = db
        self._packages = ComponentPackageService(db)
        self._actions = ComponentActionService(db)

    def detect(self, device: Device, component_id: str) -> RemediationPlan:
        """Detect the remediation (if any) a component needs on a device. Pure
        read — never queues."""
        component = get_component(component_id)
        status = self._packages.status_for(device, component_id)
        if component is None:
            return RemediationPlan(
                component_id=component_id, operation=None, reason="unknown_component",
                installed_version=status.installed_version,
                desired_version=status.desired_version,
                available_version=status.available_version, outdated=status.outdated,
            )

        candidates = ()
        condition = "healthy"
        if status.outdated:
            candidates, condition = _OUTDATED_OPS, "outdated"
        elif status.installed_version is None and status.desired_version:
            candidates, condition = _MISSING_OPS, "missing"

        operation = None
        for candidate in candidates:
            op = LifecycleOperation(candidate)
            if component.supports(op) and can_resolve(component_id, candidate):
                operation = candidate
                break

        reason = condition if operation else ("no_executable_remediation" if candidates else "healthy")
        return RemediationPlan(
            component_id=component_id, operation=operation, reason=reason,
            installed_version=status.installed_version,
            desired_version=status.desired_version,
            available_version=status.available_version, outdated=status.outdated,
        )

    def remediate(
        self,
        device: Device,
        component_id: str,
        *,
        created_by: Optional[str],
        dry_run: bool = False,
        auto: bool = False,
    ) -> RemediationResult:
        """Detect and (unless dry_run) queue the recommended remediation through
        the existing action path. `auto=True` (unattended) additionally requires
        the AUTO_REMEDIATION policy to permit it."""
        plan = self.detect(device, component_id)
        if plan.operation is None:
            return RemediationResult(plan=plan, acted=False, reason=plan.reason)
        if auto and not auto_remediation_allowed(component_id):
            logger.info(
                "[remediation] auto SKIPPED (policy disabled) component=%s operation=%s device=%s",
                component_id, plan.operation, getattr(device, "id", "?"),
            )
            return RemediationResult(plan=plan, acted=False, reason="auto_remediation_disabled")
        if dry_run:
            return RemediationResult(plan=plan, acted=False, reason="dry_run")
        try:
            result = self._actions.execute(
                device, component_id, plan.operation, created_by=created_by
            )
        except ComponentActionError as exc:
            return RemediationResult(plan=plan, acted=False, reason=exc.code.value, error=exc.message)
        except ValueError as exc:
            return RemediationResult(plan=plan, acted=False, reason="conflict", error=str(exc))
        return RemediationResult(plan=plan, acted=True, reason="queued", action=result.action)
