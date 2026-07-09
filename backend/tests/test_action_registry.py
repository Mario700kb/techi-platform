"""The Action Registry is the single source of truth for executable operations.
These tests lock it to the existing permission/label maps (so nothing drifts as
the live enforcement is migrated onto it) and verify capability-driven
availability with the Windows-fallback invariant.
"""
from app.platform_core import actions as A
from app.platform_core.registry import PLATFORM_REGISTRY
from app.schemas.remote_action import ACTION_LABELS
from app.services.permission_service import ACTION_PERMISSION_MAP


def test_registry_permission_map_matches_live_map():
    # Every gated action agrees with the enforced ACTION_PERMISSION_MAP exactly.
    assert A.permission_map() == ACTION_PERMISSION_MAP


def test_registry_labels_match_live_labels():
    # Labels for every registry action match the shipped ACTION_LABELS.
    live = {(k.value if hasattr(k, "value") else str(k)): v for k, v in ACTION_LABELS.items()}
    for action_id, label in A.label_map().items():
        assert live.get(action_id) == label, action_id


def test_every_action_handler_is_the_action_id():
    for a in A.ACTION_REGISTRY.values():
        assert a.handler.value == a.id


def test_windows_no_capabilities_gets_full_declared_surface():
    # Today's Windows fleet reports no capabilities → fall back to the platform's
    # declared set, which includes remote_support, so ALL actions stay available
    # (byte-identical surface, no agent rebuild).
    eff = A.effective_capabilities("windows", None)
    assert eff == PLATFORM_REGISTRY["windows"].allowed_capabilities
    ids = {a.id for a in A.actions_for("windows", None)}
    assert {"ping", "restart_agent", "restart_device", "sync_rustdesk",
            "reinstall_rustdesk", "deploy_remote_support"} <= ids


def test_null_platform_is_treated_as_windows():
    assert A.actions_for(None, None) == A.actions_for("windows", None)


def test_linux_capabilities_hide_remote_support_show_terminal():
    caps = {"bash": "", "systemd": "", "services": "", "processes": "",
            "docker": "", "logs": "", "journal": "", "terminal": "", "interfaces": ""}
    ids = {a.id for a in A.actions_for("linux", caps)}
    # Remote Support actions require the remote_support capability (absent here).
    assert not ({"sync_rustdesk", "restart_rustdesk", "reinstall_rustdesk",
                 "deploy_remote_support"} & ids)
    # Agent-native + terminal are available.
    assert {"ping", "restart_agent", "restart_device", "refresh_inventory", "open_terminal"} <= ids


def test_linux_with_remote_support_capability_shows_it():
    ids = {a.id for a in A.actions_for("linux", {"remote_support": "", "terminal": ""})}
    assert "sync_rustdesk" in ids and "open_terminal" in ids


def test_dangerous_actions_flagged():
    dangerous = {a.id for a in A.ACTION_REGISTRY.values() if a.dangerous}
    assert dangerous == {"restart_agent", "restart_device", "reinstall_rustdesk", "deploy_remote_support"}
