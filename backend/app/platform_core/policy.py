"""Deployment Policy Registry — the DECLARATIVE model of how each component's
desired state is governed (Platform Components Phase 5).

MODEL ONLY. This declares three concepts per component and nothing else:

  * Desired Source — where the desired version is read from (today: the active
    package in the manifest; `manual`/`none` are placeholders).
  * Policy         — the governance mode: `active_package` (track the active
    package, today's behavior), `manual` (an operator-pinned version, future),
    or `future` (placeholder for a policy-engine-driven source).
  * Strategy       — how the desired state would be reached: `manual` (an
    operator triggers the existing lifecycle actions, today's behavior) or
    `future` (placeholder for rollout/canary/scheduler — deliberately NOT built).

It adds NO logic and executes NOTHING: no auto-update, scheduler, rollout,
canary, enforcement, Action Queue change, agent change, or migration. Phase 3's
desired-version resolution already reads the active package; this registry only
NAMES that as a declared policy so future work has a stable seam. Nothing here
is consulted by the resolver — behavior is unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional

from app.platform_core.components import COMPONENT_REGISTRY, list_components


class DesiredSource(str, Enum):
    """Where a component's desired version is read from."""

    ACTIVE_PACKAGE = "active_package"  # the active package in the manifest (today)
    MANUAL = "manual"                  # an operator-pinned version (future)
    NONE = "none"                      # no source resolved (placeholder)


class ComponentPolicy(str, Enum):
    """The governance mode for a component's desired state."""

    ACTIVE_PACKAGE = "active_package"  # track the active package (today's behavior)
    MANUAL = "manual"                  # operator pins the desired version (future)
    FUTURE = "future"                  # placeholder for a policy-engine source


class DeploymentStrategy(str, Enum):
    """How the desired state would be reached. No strategy is executed here."""

    MANUAL = "manual"  # operator triggers the existing lifecycle actions (today)
    FUTURE = "future"  # placeholder for rollout/canary/scheduler (NOT built)


@dataclass(frozen=True)
class ComponentPolicyDescriptor:
    component_id: str
    desired_source: DesiredSource
    policy: ComponentPolicy
    strategy: DeploymentStrategy


# Today every managed component tracks the active package and is deployed by an
# operator triggering the existing lifecycle actions manually — no automation.
# MANUAL/FUTURE enum values exist as declared placeholders and are intentionally
# not assigned to any component yet.
_POLICIES: tuple[ComponentPolicyDescriptor, ...] = (
    ComponentPolicyDescriptor(
        component_id="agent",
        desired_source=DesiredSource.ACTIVE_PACKAGE,
        policy=ComponentPolicy.ACTIVE_PACKAGE,
        strategy=DeploymentStrategy.MANUAL,
    ),
    ComponentPolicyDescriptor(
        component_id="remote_support",
        desired_source=DesiredSource.ACTIVE_PACKAGE,
        policy=ComponentPolicy.ACTIVE_PACKAGE,
        strategy=DeploymentStrategy.MANUAL,
    ),
)

COMPONENT_POLICY_REGISTRY: Dict[str, ComponentPolicyDescriptor] = {
    p.component_id: p for p in _POLICIES
}


def validate_policy_registry() -> None:
    """Fail-closed 1:1 coverage guard (mirrors the other platform_core registries'
    import-time checks): every component has exactly one policy and every policy
    names a real component. Raises ValueError otherwise."""
    component_ids = {c.id for c in list_components()}
    policy_ids = set(COMPONENT_POLICY_REGISTRY)
    missing = component_ids - policy_ids
    if missing:
        raise ValueError(f"Components without a deployment policy: {sorted(missing)}")
    unknown = policy_ids - set(COMPONENT_REGISTRY)
    if unknown:
        raise ValueError(f"Policies for unknown components: {sorted(unknown)}")


def policy_for(component_id: Optional[str]) -> Optional[ComponentPolicyDescriptor]:
    """The deployment policy descriptor for a component, or None if unknown."""
    if not component_id:
        return None
    return COMPONENT_POLICY_REGISTRY.get(str(component_id).strip().lower())


def list_policies() -> List[ComponentPolicyDescriptor]:
    """All policy descriptors in component-registry order."""
    return [COMPONENT_POLICY_REGISTRY[c.id] for c in list_components()]


validate_policy_registry()
