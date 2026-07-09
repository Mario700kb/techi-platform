"""Action Registry — the single source of truth for every executable device
operation (Platform Expansion, registry-driven Device Drawer).

One `ActionDescriptor` per operation carries everything the four consumers need:
  * UI          — `label`, `confirm`, `target`, `required_capability`
  * permissions — `permission` (the existing permission vocabulary)
  * audit       — `audit_action`
  * execution   — `handler` (the queued ActionType) + `target`

Availability is capability-driven: an action is offered for a device iff its
`required_capability` is None (agent-native — every managed device) OR that
capability is in the device's EFFECTIVE capabilities. A device that reports NO
capabilities (every current Windows agent, which predates capability reporting)
falls back to its platform's registry-declared capability set — so Windows keeps
its full action set byte-identically without an agent rebuild ("absence ⇒ the
platform's declared capabilities", the same rule the classification engine uses).

Adding a platform's operations = registry entries here. No Drawer/Management/UI
branching. Launchers/handlers themselves live in the existing execution pipeline
(RemoteActionService.queue_action); this module only declares WHAT exists and
WHEN it is available, and is the source the permission/label maps derive from.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, FrozenSet, List, Optional

from app.platform_core.classification import classify_platform
from app.platform_core.registry import PLATFORM_REGISTRY
from app.schemas.remote_action import ActionType

# Permission vocabulary (values mirror app.services.permission_service; kept as
# literals here so platform_core has no upward dependency on services — a
# contract test asserts they stay in lock-step with ACTION_PERMISSION_MAP).
PERM_DIAGNOSTICS = "diagnostics"
PERM_VIEW_INVENTORY = "view_inventory"
PERM_REMOTE_SUPPORT_MANAGE = "remote_support_manage"
PERM_REINSTALL_REMOTE_SUPPORT = "reinstall_remote_support"
PERM_DEPLOYMENT = "deployment"
PERM_RESTART_AGENT = "restart_agent"
PERM_RESTART_DEVICE = "restart_device"
PERM_MAINTENANCE_MODE = "maintenance_mode"

TARGET_AGENT = "agent"
TARGET_DEVICE = "device"

CONFIRM_NONE = "none"
CONFIRM_REQUIRED = "confirm"


@dataclass(frozen=True)
class ActionDescriptor:
    id: str                          # stable action id (== queued ActionType value)
    label: str                       # UI label
    permission: Optional[str]        # required permission, or None = no gate
    required_capability: Optional[str]  # None = agent-native (always available)
    confirm: str                     # CONFIRM_NONE | CONFIRM_REQUIRED
    audit_action: str                # audit event recorded on queue
    target: str                      # TARGET_AGENT | TARGET_DEVICE
    handler: ActionType              # what the execution pipeline queues

    @property
    def dangerous(self) -> bool:
        return self.confirm == CONFIRM_REQUIRED


# Ordered; the UI renders in this order (grouped by capability by the renderer).
_ACTIONS: tuple[ActionDescriptor, ...] = (
    # Agent-native (any managed device, Windows or not) ----------------------
    ActionDescriptor("ping", "Ping", PERM_DIAGNOSTICS, None, CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.PING),
    ActionDescriptor("immediate_heartbeat", "Immediate Heartbeat", PERM_DIAGNOSTICS, None, CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.IMMEDIATE_HEARTBEAT),
    ActionDescriptor("refresh_inventory", "Refresh Inventory", PERM_VIEW_INVENTORY, None, CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.REFRESH_INVENTORY),
    ActionDescriptor("sync_inventory", "Sync Inventory", PERM_VIEW_INVENTORY, None, CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.SYNC_INVENTORY),
    ActionDescriptor("apply_power_policy", "Apply Power Policy", PERM_MAINTENANCE_MODE, None, CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.APPLY_POWER_POLICY),
    ActionDescriptor("self_update", "Self Update Agent", None, None, CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.SELF_UPDATE),
    ActionDescriptor("restart_agent", "Restart Agent", PERM_RESTART_AGENT, None, CONFIRM_REQUIRED, "action_queued", TARGET_AGENT, ActionType.RESTART_AGENT),
    ActionDescriptor("restart_device", "Restart Device", PERM_RESTART_DEVICE, None, CONFIRM_REQUIRED, "action_queued", TARGET_DEVICE, ActionType.RESTART_DEVICE),
    # Remote Support (requires the remote_support capability) -----------------
    ActionDescriptor("sync_rustdesk", "Sync TECHI Remote Support", PERM_REMOTE_SUPPORT_MANAGE, "remote_support", CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.SYNC_RUSTDESK),
    ActionDescriptor("restart_rustdesk", "Restart TECHI Remote Support", PERM_REMOTE_SUPPORT_MANAGE, "remote_support", CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.RESTART_RUSTDESK),
    ActionDescriptor("reopen_rustdesk", "Reopen TECHI Remote Support", PERM_REMOTE_SUPPORT_MANAGE, "remote_support", CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.REOPEN_RUSTDESK),
    ActionDescriptor("repair_config_rustdesk", "Repair TECHI Remote Support Config", PERM_REMOTE_SUPPORT_MANAGE, "remote_support", CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.REPAIR_CONFIG_RUSTDESK),
    ActionDescriptor("reinstall_rustdesk", "Reinstall TECHI Remote Support", PERM_REINSTALL_REMOTE_SUPPORT, "remote_support", CONFIRM_REQUIRED, "action_queued", TARGET_AGENT, ActionType.REINSTALL_RUSTDESK),
    ActionDescriptor("deploy_remote_support", "Deploy / Upgrade TECHI Remote Support", PERM_DEPLOYMENT, "remote_support", CONFIRM_REQUIRED, "action_queued", TARGET_AGENT, ActionType.DEPLOY_REMOTE_SUPPORT),
    # Terminal (requires the terminal capability) ----------------------------
    ActionDescriptor("open_terminal", "Open Web Terminal", None, "terminal", CONFIRM_NONE, "action_queued", TARGET_AGENT, ActionType.OPEN_TERMINAL),
)

ACTION_REGISTRY: Dict[str, ActionDescriptor] = {a.id: a for a in _ACTIONS}


def permission_map() -> Dict[str, str]:
    """{action_id: permission} — the source the permission layer consumes."""
    return {a.id: a.permission for a in _ACTIONS if a.permission}


def label_map() -> Dict[str, str]:
    return {a.id: a.label for a in _ACTIONS}


def effective_capabilities(platform: Optional[str], capabilities: Optional[dict]) -> FrozenSet[str]:
    """A device's capabilities for availability decisions. Reported set wins;
    absence falls back to the platform's registry-declared capabilities so a
    capability-less agent (today's Windows fleet) keeps its full surface."""
    caps = capabilities or {}
    if caps:
        return frozenset(str(k).strip().lower() for k in caps)
    descriptor = PLATFORM_REGISTRY.get(classify_platform(platform))
    return descriptor.allowed_capabilities if descriptor else frozenset()


def actions_for(platform: Optional[str], capabilities: Optional[dict]) -> List[ActionDescriptor]:
    """Available actions for a device, in registry order."""
    eff = effective_capabilities(platform, capabilities)
    return [a for a in _ACTIONS if a.required_capability is None or a.required_capability in eff]
