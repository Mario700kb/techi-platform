"""
Tests for management action validation and permission enforcement.

Verifies:
- All Remote Support action types are in ACTION_PERMISSION_MAP and require remote_support_manage.
- Unsupported actions (gpupdate, flush_dns, defender_quick_scan, etc.) are NOT in ActionType.
- Pydantic rejects unknown action type strings at schema validation time.
- repair_config_rustdesk is present in both the backend schema and permission map.
"""

import pytest
from pydantic import ValidationError

from app.schemas.remote_action import ActionType, RemoteActionCreate
from app.services.permission_service import ACTION_PERMISSION_MAP, REMOTE_SUPPORT_MANAGE


class TestUnsupportedActionsAbsent:
    """Actions not implemented in the agent must not appear in ActionType."""

    _UNSUPPORTED = [
        "gpupdate",
        "flush_dns",
        "restart_print_spooler",
        "windows_update_scan",
        "windows_update_install",
        "defender_signature_update",
        "defender_quick_scan",
    ]

    def test_unsupported_actions_not_in_enum(self):
        values = {a.value for a in ActionType}
        for action in self._UNSUPPORTED:
            assert action not in values, (
                f"'{action}' must not be in ActionType — "
                "the agent does not support it and faking it would silently fail"
            )


class TestUnknownActionTypeRejected:
    """Pydantic must reject unknown action type strings at schema validation time."""

    def test_gpupdate_raises_validation_error(self):
        with pytest.raises(ValidationError):
            RemoteActionCreate(action_type="gpupdate")

    def test_flush_dns_raises_validation_error(self):
        with pytest.raises(ValidationError):
            RemoteActionCreate(action_type="flush_dns")

    def test_empty_string_raises_validation_error(self):
        with pytest.raises(ValidationError):
            RemoteActionCreate(action_type="")

    def test_arbitrary_string_raises_validation_error(self):
        with pytest.raises(ValidationError):
            RemoteActionCreate(action_type="totally_fake_action")


class TestRemoteSupportActionPermissions:
    """All Remote Support action types must require the correct permission."""

    _RS_MANAGE_ACTIONS = [
        "restart_rustdesk",
        "sync_rustdesk",
        "reopen_rustdesk",
        "repair_config_rustdesk",
    ]

    def test_all_rs_manage_actions_in_permission_map(self):
        for action in self._RS_MANAGE_ACTIONS:
            assert action in ACTION_PERMISSION_MAP, (
                f"'{action}' is missing from ACTION_PERMISSION_MAP"
            )

    def test_all_rs_manage_actions_require_remote_support_manage(self):
        for action in self._RS_MANAGE_ACTIONS:
            got = ACTION_PERMISSION_MAP[action]
            assert got == REMOTE_SUPPORT_MANAGE, (
                f"'{action}' should require '{REMOTE_SUPPORT_MANAGE}', got '{got}'"
            )

    def test_repair_config_rustdesk_in_action_type_enum(self):
        values = {a.value for a in ActionType}
        assert "repair_config_rustdesk" in values

    def test_repair_config_rustdesk_schema_valid(self):
        schema = RemoteActionCreate(action_type="repair_config_rustdesk")
        assert schema.action_type.value == "repair_config_rustdesk"

    def test_reinstall_rustdesk_requires_reinstall_permission(self):
        from app.services.permission_service import REINSTALL_REMOTE_SUPPORT
        assert ACTION_PERMISSION_MAP.get("reinstall_rustdesk") == REINSTALL_REMOTE_SUPPORT
