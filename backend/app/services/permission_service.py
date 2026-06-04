"""
Centralised permission matrix.

Every permission check in the application should reference ROLE_PERMISSIONS
rather than scattering string comparisons through route handlers.
"""

from typing import Dict, FrozenSet, List

# ── Permission identifiers ──────────────────────────────────────────────── #

VIEW_DEVICES = "view_devices"
REMOTE_SUPPORT_CONNECT = "remote_support_connect"
REMOTE_SUPPORT_MANAGE = "remote_support_manage"
RESTART_DEVICE = "restart_device"
RESTART_AGENT = "restart_agent"
REINSTALL_REMOTE_SUPPORT = "reinstall_remote_support"
MAINTENANCE_MODE = "maintenance_mode"
DIAGNOSTICS = "diagnostics"
VIEW_NOTES = "view_notes"
EDIT_NOTES = "edit_notes"
VIEW_INVENTORY = "view_inventory"
VIEW_PATCH = "view_patch"
DEPLOYMENT = "deployment"
MANAGE_CLIENTS = "manage_clients"
MANAGE_GROUPS = "manage_groups"
MANAGE_OPERATORS = "manage_operators"
AUDIT_LOG = "audit_log"
SYSTEM_SETTINGS = "system_settings"

ALL_PERMISSIONS: FrozenSet[str] = frozenset({
    VIEW_DEVICES, REMOTE_SUPPORT_CONNECT, REMOTE_SUPPORT_MANAGE,
    RESTART_DEVICE, RESTART_AGENT, REINSTALL_REMOTE_SUPPORT, MAINTENANCE_MODE,
    DIAGNOSTICS, VIEW_NOTES, EDIT_NOTES, VIEW_INVENTORY, VIEW_PATCH,
    DEPLOYMENT, MANAGE_CLIENTS, MANAGE_GROUPS, MANAGE_OPERATORS, AUDIT_LOG,
    SYSTEM_SETTINGS,
})

ROLE_PERMISSIONS: Dict[str, FrozenSet[str]] = {
    "owner": ALL_PERMISSIONS,
    "admin": frozenset({
        VIEW_DEVICES, REMOTE_SUPPORT_CONNECT, REMOTE_SUPPORT_MANAGE,
        RESTART_DEVICE, RESTART_AGENT, REINSTALL_REMOTE_SUPPORT, MAINTENANCE_MODE,
        DIAGNOSTICS, VIEW_NOTES, EDIT_NOTES, VIEW_INVENTORY, VIEW_PATCH,
        DEPLOYMENT, MANAGE_CLIENTS, MANAGE_GROUPS, MANAGE_OPERATORS, AUDIT_LOG,
    }),
    "operator": frozenset({
        VIEW_DEVICES, REMOTE_SUPPORT_CONNECT, REMOTE_SUPPORT_MANAGE,
        RESTART_DEVICE, RESTART_AGENT, REINSTALL_REMOTE_SUPPORT, MAINTENANCE_MODE,
        DIAGNOSTICS, VIEW_NOTES, EDIT_NOTES, VIEW_INVENTORY, VIEW_PATCH,
    }),
    "readonly": frozenset({
        VIEW_DEVICES, VIEW_NOTES, VIEW_INVENTORY, VIEW_PATCH,
    }),
}

# Maps ActionType string values → permission key required to queue that action.
ACTION_PERMISSION_MAP: Dict[str, str] = {
    "ping": DIAGNOSTICS,
    "immediate_heartbeat": DIAGNOSTICS,
    "refresh_inventory": VIEW_INVENTORY,
    "sync_inventory": VIEW_INVENTORY,
    "sync_rustdesk": REMOTE_SUPPORT_MANAGE,
    "restart_rustdesk": REMOTE_SUPPORT_MANAGE,
    "reopen_rustdesk": REMOTE_SUPPORT_MANAGE,
    "repair_config_rustdesk": REMOTE_SUPPORT_MANAGE,
    "reinstall_rustdesk": REINSTALL_REMOTE_SUPPORT,
    "deploy_remote_support": DEPLOYMENT,
    "restart_agent": RESTART_AGENT,
    "restart_device": RESTART_DEVICE,
    "apply_power_policy": MAINTENANCE_MODE,
}


def get_permissions_for_role(role: str) -> FrozenSet[str]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def has_permission(role: str, permission: str) -> bool:
    return permission in get_permissions_for_role(role)


def permissions_summary(role: str) -> dict:
    granted = get_permissions_for_role(role)
    return {
        "role": role,
        "permissions": sorted(granted),
        "denied": sorted(ALL_PERMISSIONS - granted),
    }
