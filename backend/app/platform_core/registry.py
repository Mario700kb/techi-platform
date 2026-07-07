"""Platform Registry — the controlled set of managed platforms.

Contract (PLATFORM-EXPANSION-AUDIT.md §1/§6/§13): a platform is data plus an
adapter, never a UI or API fork. Absence of a platform value on a device means
``windows`` (the reference implementation) — no backfill of existing rows.
Adding a platform here is only valid together with its audit §6 matrix row and
Appendix C certification track.
"""

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Optional, Tuple

from app.platform_core.capabilities import KNOWN_CAPABILITIES

DEFAULT_PLATFORM_ID = "windows"

MODE_NATIVE_AGENT = "native_agent"
MODE_PROXY_ADAPTER = "proxy_adapter"


@dataclass(frozen=True)
class PlatformDescriptor:
    id: str
    display_name: str
    mode: str  # MODE_NATIVE_AGENT | MODE_PROXY_ADAPTER
    feature_flag: str  # settings attribute gating every surface of this platform
    connect_methods: Tuple[str, ...] = ()
    # Capabilities this platform may ever report; a device reports a subset.
    allowed_capabilities: FrozenSet[str] = field(default_factory=frozenset)
    # Appendix C stage. Windows is grandfathered LTS (reference implementation).
    certification_stage: str = "pre-experimental"


PLATFORM_REGISTRY: Dict[str, PlatformDescriptor] = {
    descriptor.id: descriptor
    for descriptor in (
        PlatformDescriptor(
            id="windows",
            display_name="Windows",
            mode=MODE_NATIVE_AGENT,
            feature_flag="",  # reference implementation — never gated
            connect_methods=("remote_support",),
            allowed_capabilities=frozenset(
                {
                    "remote_support",
                    "powershell",
                    "cmd",
                    "services",
                    "processes",
                    "registry",
                    "event_viewer",
                    "packages",
                    "logs",
                }
            ),
            certification_stage="lts",
        ),
        PlatformDescriptor(
            id="linux",
            display_name="Linux",
            mode=MODE_NATIVE_AGENT,
            feature_flag="FEATURE_LINUX",
            connect_methods=("terminal", "ssh_desktop", "web_terminal", "remote_support"),
            allowed_capabilities=frozenset(
                {
                    "terminal",
                    "bash",
                    "busybox",
                    "python",
                    "services",
                    "processes",
                    "systemd",
                    "journal",
                    "docker",
                    "packages",
                    "firewall",
                    "interfaces",
                    "logs",
                    "remote_support",
                }
            ),
        ),
        PlatformDescriptor(
            id="mikrotik",
            display_name="MikroTik",
            mode=MODE_PROXY_ADAPTER,
            feature_flag="FEATURE_MIKROTIK",
            connect_methods=("winbox", "webfig", "ssh", "terminal"),
            allowed_capabilities=frozenset(
                {"terminal", "interfaces", "wireless", "firewall", "logs"}
            ),
        ),
        PlatformDescriptor(
            id="synology",
            display_name="Synology",
            mode=MODE_PROXY_ADAPTER,
            feature_flag="FEATURE_STORAGE",
            connect_methods=("dsm", "ssh"),
            allowed_capabilities=frozenset({"terminal", "storage", "packages", "logs"}),
        ),
        PlatformDescriptor(
            id="qnap",
            display_name="QNAP",
            mode=MODE_PROXY_ADAPTER,
            feature_flag="FEATURE_STORAGE",
            connect_methods=("qts", "ssh"),
            allowed_capabilities=frozenset({"terminal", "storage", "packages", "logs"}),
        ),
        PlatformDescriptor(
            id="vmware",
            display_name="VMware",
            mode=MODE_PROXY_ADAPTER,
            feature_flag="FEATURE_HYPERVISOR",
            connect_methods=("vsphere", "ssh"),
            allowed_capabilities=frozenset({"hypervisor", "storage", "logs"}),
        ),
        PlatformDescriptor(
            id="hyperv",
            display_name="Hyper-V",
            mode=MODE_PROXY_ADAPTER,  # host itself is covered by the Windows agent
            feature_flag="FEATURE_HYPERVISOR",
            connect_methods=("remote_support",),
            allowed_capabilities=frozenset({"hypervisor", "powershell", "logs"}),
        ),
        PlatformDescriptor(
            id="proxmox",
            display_name="Proxmox",
            mode=MODE_PROXY_ADAPTER,
            feature_flag="FEATURE_HYPERVISOR",
            connect_methods=("web", "ssh", "terminal"),
            allowed_capabilities=frozenset(
                {"hypervisor", "terminal", "bash", "storage", "logs"}
            ),
        ),
    )
}

# Every allowed capability must exist in the controlled vocabulary.
for _descriptor in PLATFORM_REGISTRY.values():
    _unknown = _descriptor.allowed_capabilities - KNOWN_CAPABILITIES
    if _unknown:
        raise ValueError(
            f"Platform '{_descriptor.id}' declares unknown capabilities: {sorted(_unknown)}"
        )


def is_known_platform(value: Optional[str]) -> bool:
    return isinstance(value, str) and value.strip().lower() in PLATFORM_REGISTRY


def resolve_platform(value: Optional[str]) -> Optional[PlatformDescriptor]:
    """Resolve a device's platform value to a descriptor.

    ``None``/empty resolves to Windows (audit §8: absence ⇒ windows — existing
    rows are never backfilled). An unknown non-empty value returns ``None`` so
    callers fail closed instead of silently treating a future platform as
    Windows.
    """
    if value is None or not str(value).strip():
        return PLATFORM_REGISTRY[DEFAULT_PLATFORM_ID]
    return PLATFORM_REGISTRY.get(str(value).strip().lower())
