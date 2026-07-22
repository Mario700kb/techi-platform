"""Component Action Validator — the single ordered validation layer. Each check
raises a ComponentActionError with a stable code; no scattered branching.
"""
from types import SimpleNamespace

import pytest

from app.platform_core.action_resolver import (
    ComponentActionError,
    ComponentActionErrorCode,
)
from app.services.component_action_validator import ComponentActionValidator


def _device(platform="windows", capabilities=None):
    # Only the fields the validator reads (platform, capabilities).
    return SimpleNamespace(platform=platform, capabilities=capabilities)


def _validate(device, component, operation, parameters=None, timeout_seconds=None):
    return ComponentActionValidator(db=None).validate(
        device, component, operation,
        parameters=parameters, timeout_seconds=timeout_seconds,
    )


# --------------------------------------------------------------------------- #
# Passes                                                                       #
# --------------------------------------------------------------------------- #
def test_valid_agent_update_passes():
    resolved = _validate(_device(), "agent", "update")
    assert resolved.action_type.value == "self_update"


def test_valid_remote_support_repair_passes_with_capability():
    resolved = _validate(
        _device(capabilities={"remote_support": ""}), "remote_support", "repair"
    )
    assert resolved.action_type.value == "repair_config_rustdesk"


def test_valid_version_parameter_passes():
    resolved = _validate(_device(), "agent", "update", parameters={"version": "2.1.6"})
    assert resolved.action_type.value == "self_update"


# --------------------------------------------------------------------------- #
# Structured failures, in check order                                          #
# --------------------------------------------------------------------------- #
def test_unknown_component():
    with pytest.raises(ComponentActionError) as exc:
        _validate(_device(), "nope", "update")
    assert exc.value.code is ComponentActionErrorCode.UNKNOWN_COMPONENT


def test_unsupported_operation():
    with pytest.raises(ComponentActionError) as exc:
        _validate(_device(), "agent", "sync")
    assert exc.value.code is ComponentActionErrorCode.UNSUPPORTED_OPERATION


def test_out_of_band_not_executable():
    with pytest.raises(ComponentActionError) as exc:
        _validate(_device(), "agent", "install")
    assert exc.value.code is ComponentActionErrorCode.NOT_EXECUTABLE


def test_unavailable_for_device_when_capability_absent():
    # Device reports capabilities but not remote_support.
    with pytest.raises(ComponentActionError) as exc:
        _validate(_device(capabilities={"terminal": ""}), "remote_support", "repair")
    assert exc.value.code is ComponentActionErrorCode.UNAVAILABLE_FOR_DEVICE


def test_invalid_version_parameter_rejected():
    with pytest.raises(ComponentActionError) as exc:
        _validate(_device(), "agent", "update", parameters={"version": "not-a-version"})
    assert exc.value.code is ComponentActionErrorCode.INVALID_VERSION


def test_valid_timeout_passes():
    assert _validate(_device(), "agent", "update", timeout_seconds=120)


def test_out_of_range_timeout_rejected():
    for bad in (0, -5, 3601, 10 ** 9):
        with pytest.raises(ComponentActionError) as exc:
            _validate(_device(), "agent", "update", timeout_seconds=bad)
        assert exc.value.code is ComponentActionErrorCode.INVALID_TIMEOUT, bad


def test_boolean_timeout_rejected():
    # bool is an int subclass — must not be accepted as a timeout.
    with pytest.raises(ComponentActionError) as exc:
        _validate(_device(), "agent", "update", timeout_seconds=True)
    assert exc.value.code is ComponentActionErrorCode.INVALID_TIMEOUT


def test_empty_version_parameter_is_ignored():
    # Absent/empty version must not trip the format check.
    assert _validate(_device(), "agent", "update", parameters={"version": ""})
    assert _validate(_device(), "agent", "update", parameters={"other": 1})


def test_check_order_component_before_capability():
    # Unknown component beats an availability problem — resolution runs first.
    with pytest.raises(ComponentActionError) as exc:
        _validate(_device(capabilities={"terminal": ""}), "nope", "update")
    assert exc.value.code is ComponentActionErrorCode.UNKNOWN_COMPONENT


def test_capability_less_windows_agent_keeps_full_surface():
    # A capability-less Windows agent falls back to its platform's declared
    # capabilities — remote_support actions remain available (no agent rebuild).
    resolved = _validate(_device(platform="windows", capabilities=None), "remote_support", "restart")
    assert resolved.action_type.value == "restart_rustdesk"
