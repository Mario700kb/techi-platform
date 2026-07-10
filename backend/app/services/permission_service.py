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

# Enterprise Vault (2026-07-10) — granular, additive on top of the existing
# role gates (admin+ already has full Vault access via require_min_role; a
# team can ADDITIONALLY grant one of these to a non-admin operator, it never
# restricts what admin/owner already have). See api/v1/endpoints/vault.py.
VAULT_VIEW = "vault_view"
VAULT_CREATE = "vault_create"
VAULT_EDIT = "vault_edit"
VAULT_REVEAL = "vault_reveal"
VAULT_DELETE = "vault_delete"
VAULT_TEST = "vault_test"
VAULT_ASSIGN = "vault_assign"

ALL_PERMISSIONS: FrozenSet[str] = frozenset({
    VIEW_DEVICES, REMOTE_SUPPORT_CONNECT, REMOTE_SUPPORT_MANAGE,
    RESTART_DEVICE, RESTART_AGENT, REINSTALL_REMOTE_SUPPORT, MAINTENANCE_MODE,
    DIAGNOSTICS, VIEW_NOTES, EDIT_NOTES, VIEW_INVENTORY, VIEW_PATCH,
    DEPLOYMENT, MANAGE_CLIENTS, MANAGE_GROUPS, MANAGE_OPERATORS, AUDIT_LOG,
    SYSTEM_SETTINGS,
    VAULT_VIEW, VAULT_CREATE, VAULT_EDIT, VAULT_REVEAL, VAULT_DELETE, VAULT_TEST, VAULT_ASSIGN,
})

ROLE_PERMISSIONS: Dict[str, FrozenSet[str]] = {
    "owner": ALL_PERMISSIONS,
    "admin": frozenset({
        VIEW_DEVICES, REMOTE_SUPPORT_CONNECT, REMOTE_SUPPORT_MANAGE,
        RESTART_DEVICE, RESTART_AGENT, REINSTALL_REMOTE_SUPPORT, MAINTENANCE_MODE,
        DIAGNOSTICS, VIEW_NOTES, EDIT_NOTES, VIEW_INVENTORY, VIEW_PATCH,
        DEPLOYMENT, MANAGE_CLIENTS, MANAGE_GROUPS, MANAGE_OPERATORS, AUDIT_LOG,
        VAULT_VIEW, VAULT_CREATE, VAULT_EDIT, VAULT_REVEAL, VAULT_DELETE, VAULT_TEST, VAULT_ASSIGN,
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

# ActionType string value → permission required to queue it. DERIVED from the
# Action Registry (the single source of truth) — the registry descriptor's
# `permission` is what the endpoint enforces. Do not edit here; add/adjust the
# ActionDescriptor in app.platform_core.actions.
from app.platform_core.actions import permission_map as _registry_permission_map  # noqa: E402

ACTION_PERMISSION_MAP: Dict[str, str] = _registry_permission_map()


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
