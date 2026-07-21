"""Deployment Policy Registry — declarative model only (Desired Source / Policy /
Strategy). No logic, no execution, no enforcement.
"""
import pytest

from app.platform_core import policy as P
from app.platform_core.components import list_components


def test_every_component_has_exactly_one_policy():
    component_ids = {c.id for c in list_components()}
    assert set(P.COMPONENT_POLICY_REGISTRY) == component_ids
    # list order follows the component registry.
    assert [p.component_id for p in P.list_policies()] == [c.id for c in list_components()]


def test_current_components_track_the_active_package_manually():
    for descriptor in P.list_policies():
        assert descriptor.desired_source == P.DesiredSource.ACTIVE_PACKAGE
        assert descriptor.policy == P.ComponentPolicy.ACTIVE_PACKAGE
        assert descriptor.strategy == P.DeploymentStrategy.MANUAL


def test_policy_for_lookup():
    agent = P.policy_for("agent")
    assert agent.component_id == "agent"
    assert agent.policy.value == "active_package"
    assert P.policy_for("remote_support").desired_source.value == "active_package"
    assert P.policy_for("nope") is None
    assert P.policy_for(None) is None


def test_placeholder_enum_values_exist_but_are_unused():
    # MANUAL/FUTURE placeholders are declared for future work and assigned to no
    # component yet — the model names them without using them.
    assert P.ComponentPolicy.MANUAL.value == "manual"
    assert P.ComponentPolicy.FUTURE.value == "future"
    assert P.DeploymentStrategy.FUTURE.value == "future"
    assert P.DesiredSource.NONE.value == "none"
    used_policies = {d.policy for d in P.list_policies()}
    assert P.ComponentPolicy.FUTURE not in used_policies
    assert P.ComponentPolicy.MANUAL not in used_policies


def test_validation_passes():
    P.validate_policy_registry()  # already ran at import; must not raise


def test_descriptor_is_immutable():
    descriptor = P.policy_for("agent")
    with pytest.raises(Exception):
        descriptor.policy = P.ComponentPolicy.MANUAL  # frozen dataclass
