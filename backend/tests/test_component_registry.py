"""The Component Registry is an abstraction layer over the EXISTING package/
action systems — it must classify what already exists without changing any
production contract. These tests lock:

  * every existing file_type is owned by exactly one component (full,
    non-overlapping coverage) — the backward-compatibility guarantee;
  * every lifecycle handler is a real, existing queued action;
  * declared capabilities are in the controlled vocabulary;
  * the desired-state health model derives correctly.
"""
from app.platform_core import components as C
from app.platform_core.actions import ACTION_REGISTRY
from app.platform_core.capabilities import KNOWN_CAPABILITIES
from app.schemas.agent_package import AgentFileType


def test_every_file_type_is_owned_by_exactly_one_component():
    # Backward compatibility: no existing file_type string is left unclassified
    # and none is claimed twice. This is the core "registry only classifies"
    # guarantee — if a new AgentFileType is added, this test forces a decision.
    owned = {}
    for component in C.list_components():
        for ft in component.file_types:
            assert ft.value not in owned, f"{ft.value} claimed twice"
            owned[ft.value] = component.id
    assert set(owned) == {ft.value for ft in AgentFileType}


def test_file_type_strings_are_unchanged():
    # The registry must reuse the EXACT existing enum values — never invent or
    # rename a string that travels in URLs / GPO scripts / action payloads.
    agent = C.get_component("agent")
    rs = C.get_component("remote_support")
    assert set(agent.file_type_values) == {"msi", "agent_binary", "agent_update_msi"}
    assert set(rs.file_type_values) == {
        "remote_support_msi",
        "remote_support_bundle",
        "remote_support_dmg",
        "remote_support_pkg",
    }


def test_component_for_file_type_maps_existing_strings():
    assert C.component_for_file_type("msi").id == "agent"
    assert C.component_for_file_type("agent_binary").id == "agent"
    assert C.component_for_file_type("remote_support_msi").id == "remote_support"
    assert C.component_for_file_type("remote_support_dmg").id == "remote_support"
    assert C.component_for_file_type("does_not_exist") is None
    assert C.component_for_file_type(None) is None


def test_lifecycle_handlers_are_real_existing_actions():
    # Every non-None lifecycle handler must be an action that already exists in
    # the Action Registry (so the abstraction never invents execution paths).
    for component in C.list_components():
        for op, handler in component.lifecycle.items():
            if handler is None:
                continue
            assert handler.value in ACTION_REGISTRY, f"{component.id}:{op} -> {handler}"


def test_agent_lifecycle_maps_to_known_handlers():
    agent = C.get_component("agent")
    assert agent.handler_for(C.LifecycleOperation.UPDATE).value == "self_update"
    assert agent.handler_for(C.LifecycleOperation.RESTART).value == "restart_agent"
    # Install (GPO/NETLOGON) and discover (heartbeat) are supported concepts with
    # no queued-action handler.
    assert agent.supports(C.LifecycleOperation.INSTALL)
    assert agent.handler_for(C.LifecycleOperation.INSTALL) is None
    assert agent.supports(C.LifecycleOperation.DISCOVER)
    assert agent.handler_for(C.LifecycleOperation.DISCOVER) is None
    # The agent does not "sync" or "repair" as lifecycle ops.
    assert not agent.supports(C.LifecycleOperation.SYNC)
    assert not agent.supports(C.LifecycleOperation.REPAIR)


def test_remote_support_lifecycle_maps_to_known_handlers():
    rs = C.get_component("remote_support")
    assert rs.handler_for(C.LifecycleOperation.INSTALL).value == "deploy_remote_support"
    assert rs.handler_for(C.LifecycleOperation.UPDATE).value == "deploy_remote_support"
    assert rs.handler_for(C.LifecycleOperation.REINSTALL).value == "reinstall_rustdesk"
    assert rs.handler_for(C.LifecycleOperation.REPAIR).value == "repair_config_rustdesk"
    assert rs.handler_for(C.LifecycleOperation.RESTART).value == "restart_rustdesk"
    assert rs.handler_for(C.LifecycleOperation.SYNC).value == "sync_rustdesk"


def test_declared_capabilities_are_known():
    for component in C.list_components():
        assert component.capabilities <= KNOWN_CAPABILITIES
    assert C.get_component("remote_support").capabilities == frozenset({"remote_support"})
    assert C.get_component("agent").capabilities == frozenset()


def test_components_for_platform_uses_windows_default():
    win = {c.id for c in C.components_for_platform("windows")}
    assert win == {"agent", "remote_support"}
    # Absence ⇒ windows (same rule as the rest of platform_core).
    assert C.components_for_platform(None) == C.components_for_platform("windows")
    # Linux has the agent but no Remote Support package file_type.
    linux = {c.id for c in C.components_for_platform("linux")}
    assert linux == {"agent"}
    # macOS (darwin) has Remote Support (dmg/pkg) but no agent package.
    darwin = {c.id for c in C.components_for_platform("darwin")}
    assert darwin == {"remote_support"}


def test_health_missing_when_installed_absent_but_desired_present():
    assert C.derive_health(None, "2.1.14") == C.ComponentHealth.MISSING
    assert C.derive_health("", "2.1.14") == C.ComponentHealth.MISSING


def test_health_unknown_when_both_absent():
    # Nothing to compare on either side → UNKNOWN (not MISSING).
    assert C.derive_health(None, None) == C.ComponentHealth.UNKNOWN
    assert C.derive_health("", "") == C.ComponentHealth.UNKNOWN


def test_health_outdated_current_ahead():
    assert C.derive_health("2.1.5", "2.1.14") == C.ComponentHealth.OUTDATED
    assert C.derive_health("2.1.14", "2.1.14") == C.ComponentHealth.CURRENT
    # Installed newer than desired is non-actionable at this phase → CURRENT.
    assert C.derive_health("2.2.0", "2.1.14") == C.ComponentHealth.CURRENT


def test_health_unknown_when_desired_missing_or_unparseable():
    assert C.derive_health("2.1.14", None) == C.ComponentHealth.UNKNOWN
    assert C.derive_health("2.1.14", "") == C.ComponentHealth.UNKNOWN
    # Both present but unparseable → UNKNOWN (fail-closed, never guessed).
    assert C.derive_health("1.4.6+64", "abc") == C.ComponentHealth.UNKNOWN


def test_list_file_types_for_component():
    assert set(C.list_file_types_for_component("agent")) == {
        "msi", "agent_binary", "agent_update_msi"
    }
    assert C.list_file_types_for_component("nope") == []


def test_descriptor_lifecycle_is_immutable():
    agent = C.get_component("agent")
    import pytest
    with pytest.raises(TypeError):
        agent.lifecycle[C.LifecycleOperation.UPDATE] = None  # type: ignore[index]


def test_build_component_state_snapshot():
    state = C.build_component_state("agent", "2.1.5", "2.1.14")
    assert state.component_id == "agent"
    assert state.installed_version == "2.1.5"
    assert state.desired_version == "2.1.14"
    assert state.health == C.ComponentHealth.OUTDATED
    # Empty strings normalize to None in the snapshot.
    missing = C.build_component_state("remote_support", "", "1.4.8")
    assert missing.installed_version is None
    assert missing.health == C.ComponentHealth.MISSING
