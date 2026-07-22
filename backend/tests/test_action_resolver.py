"""Component Action Resolver — component + lifecycle operation resolve to an
EXISTING queued ActionType with a base payload, or a structured
ComponentActionError. Pure domain (no DB, no FastAPI); registry-driven, no
component branching.
"""
import pytest

from app.platform_core.action_resolver import (
    ComponentActionError,
    ComponentActionErrorCode,
    ResolvedComponentAction,
    can_resolve,
    parse_operation,
    resolve_component_action,
)
from app.platform_core.components import LifecycleOperation
from app.schemas.remote_action import ActionType


# --------------------------------------------------------------------------- #
# Happy path                                                                   #
# --------------------------------------------------------------------------- #
def test_resolve_agent_update_maps_to_self_update():
    resolved = resolve_component_action("agent", "update")
    assert isinstance(resolved, ResolvedComponentAction)
    assert resolved.component_id == "agent"
    assert resolved.operation is LifecycleOperation.UPDATE
    assert resolved.action_type is ActionType.SELF_UPDATE
    assert resolved.label == "Update"
    assert resolved.payload == {}


def test_resolve_agent_restart_maps_to_restart_agent():
    resolved = resolve_component_action("agent", LifecycleOperation.RESTART)
    assert resolved.action_type is ActionType.RESTART_AGENT


def test_resolve_remote_support_operations():
    cases = {
        "install": ActionType.DEPLOY_REMOTE_SUPPORT,
        "update": ActionType.DEPLOY_REMOTE_SUPPORT,
        "reinstall": ActionType.REINSTALL_RUSTDESK,
        "repair": ActionType.REPAIR_CONFIG_RUSTDESK,
        "restart": ActionType.RESTART_RUSTDESK,
        "sync": ActionType.SYNC_RUSTDESK,
    }
    for op, expected in cases.items():
        resolved = resolve_component_action("remote_support", op)
        assert resolved.action_type is expected, op


def test_payload_passes_operator_parameters_through_unchanged():
    params = {"version": "1.2.3", "target_sha256": "abc"}
    resolved = resolve_component_action("agent", "update", parameters=params)
    assert resolved.payload == params
    # A copy is taken — resolver never holds the caller's mutable dict.
    params["version"] = "9.9.9"
    assert resolved.payload["version"] == "1.2.3"


def test_component_id_and_operation_are_normalized():
    resolved = resolve_component_action("  AGENT ", "  UPDATE ")
    assert resolved.component_id == "agent"
    assert resolved.operation is LifecycleOperation.UPDATE


# --------------------------------------------------------------------------- #
# Structured errors                                                            #
# --------------------------------------------------------------------------- #
def test_unknown_component_raises_structured_error():
    with pytest.raises(ComponentActionError) as exc:
        resolve_component_action("nope", "update")
    assert exc.value.code is ComponentActionErrorCode.UNKNOWN_COMPONENT
    assert exc.value.component_id == "nope"


def test_unknown_operation_raises_structured_error():
    with pytest.raises(ComponentActionError) as exc:
        resolve_component_action("agent", "frobnicate")
    assert exc.value.code is ComponentActionErrorCode.UNKNOWN_OPERATION


def test_unsupported_operation_raises_structured_error():
    # agent does not declare sync.
    with pytest.raises(ComponentActionError) as exc:
        resolve_component_action("agent", "sync")
    assert exc.value.code is ComponentActionErrorCode.UNSUPPORTED_OPERATION
    assert exc.value.component_id == "agent"
    assert exc.value.operation == "sync"


def test_out_of_band_operation_is_not_executable():
    # agent install is GPO/NETLOGON (action_type None); discover is heartbeat.
    for op in ("install", "discover"):
        with pytest.raises(ComponentActionError) as exc:
            resolve_component_action("agent", op)
        assert exc.value.code is ComponentActionErrorCode.NOT_EXECUTABLE, op


def test_remote_support_discover_is_not_executable():
    with pytest.raises(ComponentActionError) as exc:
        resolve_component_action("remote_support", "discover")
    assert exc.value.code is ComponentActionErrorCode.NOT_EXECUTABLE


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #
def test_parse_operation_accepts_enum_and_string():
    assert parse_operation("update") is LifecycleOperation.UPDATE
    assert parse_operation(LifecycleOperation.SYNC) is LifecycleOperation.SYNC


def test_parse_operation_rejects_garbage():
    with pytest.raises(ComponentActionError) as exc:
        parse_operation("garbage")
    assert exc.value.code is ComponentActionErrorCode.UNKNOWN_OPERATION


def test_can_resolve_never_raises():
    assert can_resolve("agent", "update") is True
    assert can_resolve("agent", "sync") is False        # unsupported
    assert can_resolve("agent", "install") is False      # out of band
    assert can_resolve("nope", "update") is False        # unknown component
    assert can_resolve("agent", "garbage") is False      # unknown operation


def test_resolved_action_is_immutable():
    resolved = resolve_component_action("agent", "update")
    with pytest.raises(Exception):
        resolved.action_type = ActionType.PING  # frozen dataclass


def test_every_resolvable_action_is_a_real_action_type():
    # Exhaustive: every (component, operation) that resolves yields a real
    # ActionType — no fabricated actions anywhere in the registry.
    from app.platform_core.components import list_components

    for component in list_components():
        for op in LifecycleOperation:
            if can_resolve(component.id, op):
                resolved = resolve_component_action(component.id, op)
                assert isinstance(resolved.action_type, ActionType)
