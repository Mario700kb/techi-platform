"""Lifecycle Registry — metadata, mapping, validation over the lifecycle each
component declares. Registry-driven (no component branching); maps only to
existing ActionTypes; no execution.
"""
import pytest

from app.platform_core import lifecycle as L
from app.platform_core.actions import ACTION_REGISTRY
from app.platform_core.components import LifecycleOperation


def test_every_operation_has_a_label():
    for operation in LifecycleOperation:
        assert operation in L.LIFECYCLE_LABELS
        assert L.LIFECYCLE_LABELS[operation]


def test_lifecycle_for_agent_metadata():
    entries = {e.operation: e for e in L.lifecycle_for("agent")}
    assert entries[LifecycleOperation.UPDATE].action_type.value == "self_update"
    assert entries[LifecycleOperation.UPDATE].kind == L.LifecycleKind.ACTION
    assert entries[LifecycleOperation.UPDATE].label == "Update"
    # install (GPO) and discover (heartbeat) are supported but out of band.
    assert entries[LifecycleOperation.INSTALL].action_type is None
    assert entries[LifecycleOperation.INSTALL].kind == L.LifecycleKind.OUT_OF_BAND
    assert entries[LifecycleOperation.DISCOVER].kind == L.LifecycleKind.OUT_OF_BAND
    # agent does not declare sync/repair/reinstall.
    assert LifecycleOperation.SYNC not in entries
    assert LifecycleOperation.REINSTALL not in entries


def test_lifecycle_for_remote_support_includes_reinstall():
    ops = {e.operation: e for e in L.lifecycle_for("remote_support")}
    assert ops[LifecycleOperation.REINSTALL].action_type.value == "reinstall_rustdesk"
    assert ops[LifecycleOperation.REINSTALL].kind == L.LifecycleKind.ACTION
    assert ops[LifecycleOperation.INSTALL].action_type.value == "deploy_remote_support"
    assert ops[LifecycleOperation.DISCOVER].action_type is None


def test_lifecycle_order_is_canonical():
    # Emitted in LifecycleOperation declaration order, filtered to supported ops.
    ops = L.operations_for("remote_support")
    canonical = [op for op in LifecycleOperation if op in ops]
    assert ops == canonical


def test_action_for_lookup():
    assert L.action_for("agent", LifecycleOperation.RESTART).value == "restart_agent"
    assert L.action_for("agent", LifecycleOperation.SYNC) is None  # unsupported
    assert L.action_for("agent", LifecycleOperation.INSTALL) is None  # out of band
    assert L.action_for("nope", LifecycleOperation.UPDATE) is None  # unknown component


def test_reverse_lookup_action_to_component_operation():
    assert L.component_operation_for_action("self_update") == ("agent", LifecycleOperation.UPDATE)
    assert L.component_operation_for_action("reinstall_rustdesk") == (
        "remote_support", LifecycleOperation.REINSTALL,
    )
    assert L.component_operation_for_action("nonexistent") is None
    assert L.component_operation_for_action(None) is None


def test_reverse_lookup_first_operation_for_shared_action():
    # deploy_remote_support backs both install and update (same component); the
    # reverse index resolves to the first (install) and never raises.
    comp, op = L.component_operation_for_action("deploy_remote_support")
    assert comp == "remote_support"
    assert op == LifecycleOperation.INSTALL


def test_all_mapped_actions_are_real():
    for action_id in L.ACTION_TO_LIFECYCLE:
        assert action_id in ACTION_REGISTRY


def test_unknown_component_is_fail_soft():
    assert L.lifecycle_for("nope") == []
    assert L.operations_for("nope") == []


def test_validation_passes_for_current_registry():
    # Import-time validation already ran; calling again must not raise.
    L.validate_lifecycle_registry()


def test_lifecycle_entry_is_immutable():
    entry = L.lifecycle_for("agent")[0]
    with pytest.raises(Exception):
        entry.operation = LifecycleOperation.SYNC  # frozen dataclass
