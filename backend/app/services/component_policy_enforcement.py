"""Component Policy Enforcement — the layer that DECIDES whether a component
action is permitted by policy (Platform Components — Operational, Milestone 10).

It composes a decision from four scopes, most-general first, and returns the
FIRST denial (fail-closed):

    global  →  tenant  →  component  →  override

* **Global policy** — a system-wide default (`GLOBAL_COMPONENT_POLICY`). Off ⇒ no
  manually-triggered component action is permitted anywhere (a kill-switch).
* **Tenant policy** — an optional per-client override
  (`TENANT_COMPONENT_POLICIES[client_id]`); absent ⇒ inherit global.
* **Component policy** — read from the STABLE declarative Policy registry
  (`policy_for`): a component whose deployment `strategy` is not ``MANUAL`` is
  automation-governed and may not be triggered by hand.
* **Override** — an explicitly-authorized override (elevated operator) bypasses the
  *soft* policy denials above. It never bypasses the hard validation layer
  (capability, executability, …) — those are not policy.

This does NOT modify the declarative Policy model (`policy.py`, STABLE): it only
*reads* it and layers enforcement on top. Global/tenant policy live here as new,
enforceable configuration (no DB table) — the seam future per-tenant rules plug
into without touching the frozen registry.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from app.platform_core.policy import DeploymentStrategy, policy_for


@dataclass(frozen=True)
class ComponentEnforcementPolicy:
    """A policy scope's stance on manually-triggered component actions."""

    manual_operations_allowed: bool = True


# System-wide default. A deliberate kill-switch: set to disallow to freeze all
# manually-triggered component actions (e.g. during an incident) without a deploy.
GLOBAL_COMPONENT_POLICY = ComponentEnforcementPolicy(manual_operations_allowed=True)

# Per-tenant (client_id) overrides. Empty by default → every tenant inherits the
# global policy. This is the enforceable seam for per-tenant rules; no DB table.
TENANT_COMPONENT_POLICIES: Dict[int, ComponentEnforcementPolicy] = {}


@dataclass(frozen=True)
class EnforcementDecision:
    allowed: bool
    scope: Optional[str] = None   # "global" | "tenant" | "component" | "override"
    reason: Optional[str] = None


_ALLOW = EnforcementDecision(allowed=True)


class ComponentPolicyEnforcer:
    """Pure decision object (no DB, no I/O). `device` need only expose
    ``client_id`` for the tenant scope."""

    def decide(
        self,
        component_id: str,
        device: Any,
        operation: Any,
        *,
        override: bool = False,
    ) -> EnforcementDecision:
        # Override authorization bypasses the soft policy scopes below.
        if override:
            return EnforcementDecision(allowed=True, scope="override")

        # 1. Global.
        if not GLOBAL_COMPONENT_POLICY.manual_operations_allowed:
            return EnforcementDecision(
                allowed=False, scope="global",
                reason="Component actions are globally disabled by policy.",
            )

        # 2. Tenant.
        client_id = getattr(device, "client_id", None)
        tenant_policy = TENANT_COMPONENT_POLICIES.get(client_id) if client_id is not None else None
        if tenant_policy is not None and not tenant_policy.manual_operations_allowed:
            return EnforcementDecision(
                allowed=False, scope="tenant",
                reason="Component actions are disabled for this tenant by policy.",
            )

        # 3. Component — read the STABLE declarative policy (never mutated here).
        descriptor = policy_for(component_id)
        if descriptor is not None and descriptor.strategy != DeploymentStrategy.MANUAL:
            return EnforcementDecision(
                allowed=False, scope="component",
                reason=(
                    f"Component '{component_id}' is governed by an automated deployment "
                    f"strategy ('{descriptor.strategy.value}') and cannot be triggered manually."
                ),
            )

        return _ALLOW
