"""Component Policy Enforcement — global/tenant/component/override decision layer.
Reads the STABLE declarative Policy (policy_for) for the component scope; global
and tenant are enforceable config seams (no DB). Fail-closed, override bypasses
soft policy only.
"""
from types import SimpleNamespace

import pytest

import app.services.component_policy_enforcement as pe
from app.platform_core.action_resolver import ComponentActionErrorCode
from app.platform_core.policy import DeploymentStrategy
from app.services.component_action_validator import ComponentActionValidator
from app.platform_core.action_resolver import ComponentActionError

ENFORCER = pe.ComponentPolicyEnforcer()


def _device(client_id=None):
    return SimpleNamespace(platform="windows", capabilities=None, client_id=client_id)


@pytest.fixture(autouse=True)
def _reset_policy():
    # Snapshot + restore the module-level policy config around each test.
    global_before = pe.GLOBAL_COMPONENT_POLICY
    tenant_before = dict(pe.TENANT_COMPONENT_POLICIES)
    yield
    pe.GLOBAL_COMPONENT_POLICY = global_before
    pe.TENANT_COMPONENT_POLICIES.clear()
    pe.TENANT_COMPONENT_POLICIES.update(tenant_before)


# --------------------------------------------------------------------------- #
# Enforcer decisions                                                          #
# --------------------------------------------------------------------------- #
def test_default_allows_manual_component():
    d = ENFORCER.decide("agent", _device(), "update")
    assert d.allowed is True


def test_global_kill_switch_denies():
    pe.GLOBAL_COMPONENT_POLICY = pe.ComponentEnforcementPolicy(manual_operations_allowed=False)
    d = ENFORCER.decide("agent", _device(), "update")
    assert d.allowed is False and d.scope == "global"


def test_tenant_policy_denies_only_its_tenant():
    pe.TENANT_COMPONENT_POLICIES[42] = pe.ComponentEnforcementPolicy(manual_operations_allowed=False)
    assert ENFORCER.decide("agent", _device(client_id=42), "update").scope == "tenant"
    assert ENFORCER.decide("agent", _device(client_id=7), "update").allowed is True


def test_component_strategy_non_manual_denies(monkeypatch):
    # Simulate a component governed by an automated strategy WITHOUT touching the
    # STABLE registry — patch the reader the enforcer uses.
    monkeypatch.setattr(
        pe, "policy_for",
        lambda cid: SimpleNamespace(strategy=DeploymentStrategy.FUTURE),
    )
    d = ENFORCER.decide("agent", _device(), "update")
    assert d.allowed is False and d.scope == "component"


def test_override_bypasses_soft_policy():
    pe.GLOBAL_COMPONENT_POLICY = pe.ComponentEnforcementPolicy(manual_operations_allowed=False)
    d = ENFORCER.decide("agent", _device(), "update", override=True)
    assert d.allowed is True and d.scope == "override"


# --------------------------------------------------------------------------- #
# Enforcement through the validator (the wired path)                          #
# --------------------------------------------------------------------------- #
def test_validator_raises_policy_denied():
    pe.GLOBAL_COMPONENT_POLICY = pe.ComponentEnforcementPolicy(manual_operations_allowed=False)
    with pytest.raises(ComponentActionError) as exc:
        ComponentActionValidator(db=None).validate(_device(), "agent", "update")
    assert exc.value.code is ComponentActionErrorCode.POLICY_DENIED


def test_validator_override_allows():
    pe.GLOBAL_COMPONENT_POLICY = pe.ComponentEnforcementPolicy(manual_operations_allowed=False)
    resolved = ComponentActionValidator(db=None).validate(
        _device(), "agent", "update", override=True
    )
    assert resolved.action_type.value == "self_update"
