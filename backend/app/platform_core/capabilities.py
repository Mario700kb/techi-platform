"""Capability Registry — the controlled vocabulary of device capabilities.

Contract (PLATFORM-EXPANSION-AUDIT.md §11): capabilities are reported by
agents/adapters at enrollment and refreshed on heartbeat; the frontend renders
exclusively from capabilities — never from platform conditionals. A capability
absent from this vocabulary is dropped on normalization, so a misbehaving or
newer agent can never inject unknown UI surfaces into an older backend.
"""

from typing import Any, Dict, FrozenSet

# Bounded by the Mission scope (audit §5): these gate remote-management
# features, not monitoring. Extending this set is an Architecture Amendment.
KNOWN_CAPABILITIES: FrozenSet[str] = frozenset(
    {
        "remote_support",
        "terminal",
        "powershell",
        "cmd",
        "bash",
        "busybox",
        "python",
        "services",
        "processes",
        "registry",
        "event_viewer",
        "docker",
        "systemd",
        "journal",
        "packages",
        "firewall",
        "interfaces",
        "wireless",
        "storage",
        "hypervisor",
        "logs",
    }
)


def is_known_capability(name: str) -> bool:
    return isinstance(name, str) and name.strip().lower() in KNOWN_CAPABILITIES


# Capability → Drawer tab. A tab appears iff the device reports any of its
# capabilities; this is the ONLY thing that decides a capability tab's presence
# (no platform branching). Command capabilities (bash/python/powershell/cmd/
# busybox) drive Command Center, not tabs; remote_support and terminal are
# rendered as their own tabs by the renderer, so they are not listed here.
_TAB_ORDER: tuple[tuple[str, frozenset], ...] = (
    ("services", frozenset({"services", "systemd"})),
    ("processes", frozenset({"processes"})),
    ("packages", frozenset({"packages"})),
    ("docker", frozenset({"docker"})),
    ("logs", frozenset({"logs", "journal"})),
    ("network", frozenset({"interfaces", "firewall", "wireless"})),
    ("storage", frozenset({"storage"})),
)


def capability_tabs(effective_caps) -> list[str]:
    """Ordered capability-driven Drawer tabs for a device's effective caps."""
    caps = {str(c).strip().lower() for c in (effective_caps or [])}
    return [tab for tab, needed in _TAB_ORDER if needed & caps]


def normalize_capabilities(reported: Any) -> Dict[str, str]:
    """Validate a reported capability payload into ``{capability: version}``.

    Accepts either a list of names (``["docker", "bash"]``) or a mapping of
    name → version (``{"docker": "26.1"}``); anything else yields ``{}``.
    Unknown capabilities are dropped, names are lowercased/trimmed, and
    versions are coerced to strings ("" when the agent sent no version), so
    downstream consumers get one predictable shape regardless of agent age.
    """
    if isinstance(reported, dict):
        items = reported.items()
    elif isinstance(reported, (list, tuple, set)):
        items = ((name, "") for name in reported)
    else:
        return {}

    normalized: Dict[str, str] = {}
    for raw_name, raw_version in items:
        if not isinstance(raw_name, str):
            continue
        name = raw_name.strip().lower()
        if name not in KNOWN_CAPABILITIES:
            continue
        normalized[name] = "" if raw_version is None else str(raw_version).strip()
    return normalized
