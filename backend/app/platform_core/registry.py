"""Platform Registry — the controlled set of managed platforms.

Contract (PLATFORM-EXPANSION-AUDIT.md §1/§6/§13): a platform is data plus an
adapter, never a UI or API fork. Absence of a platform value on a device means
``windows`` (the reference implementation) — no backfill of existing rows.
Adding a platform here is only valid together with its audit §6 matrix row and
Appendix C certification track.
"""

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Mapping, Optional, Tuple

from app.platform_core.capabilities import KNOWN_CAPABILITIES

DEFAULT_PLATFORM_ID = "windows"

MODE_NATIVE_AGENT = "native_agent"
MODE_PROXY_ADAPTER = "proxy_adapter"

# MikroTik RouterOS deployment/registration template. Deployment + registration
# ONLY — the router POSTs its identity + the enrollment token to the generic
# /agent/enroll endpoint; no on-device agent, no RouterOS management. Placeholders
# ({{...}}) are filled server-side from the Platform Registry; RouterOS runtime
# values ($arch/$rosver/$hostid) are self-detected on the router so one script
# fits every architecture. Adding RouterOS management later touches ONLY the
# Platform Adapter — never this template's consumers.
MIKROTIK_ROUTEROS6_TEMPLATE = """# TECHI Platform - MikroTik enrollment (RouterOS 6.x)
# Paste into RouterOS terminal (or import as a script). Requires outbound HTTPS.
{
:local token "{{TOKEN}}"
:local api "{{API_ENDPOINT}}"
:local platform "{{PLATFORM}}"
:local connver "{{VERSION}}"
:local arch [/system resource get architecture-name]
:local rosver [/system resource get version]
:local hostid [/system identity get name]
:local enrollUrl ($api . "/api/v1/agent/enroll")
:local body ("{\\"enrollment_token\\":\\"" . $token . "\\",\\"platform\\":\\"" . $platform . "\\",\\"hostname\\":\\"" . $hostid . "\\",\\"architecture\\":\\"" . $arch . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . $rosver . "\\",\\"agent_version\\":\\"" . $connver . "\\"}")
/tool fetch mode=https url=$enrollUrl http-method=post http-header-field="Content-Type:application/json" http-data=$body keep-result=no
:log info "TECHI enrollment submitted: $hostid ($arch, RouterOS $rosver)"
}
"""

MIKROTIK_ROUTEROS7_TEMPLATE = """# TECHI Platform - MikroTik enrollment (RouterOS 7.x)
# Paste into RouterOS terminal (or import as a script). Requires outbound HTTPS.
{
:local token "{{TOKEN}}"
:local api "{{API_ENDPOINT}}"
:local platform "{{PLATFORM}}"
:local connver "{{VERSION}}"
:local arch [/system resource get architecture-name]
:local rosver [/system resource get version]
:local hostid [/system identity get name]
:local enrollUrl ($api . "/api/v1/agent/enroll")
:local body ("{\\"enrollment_token\\":\\"" . $token . "\\",\\"platform\\":\\"" . $platform . "\\",\\"hostname\\":\\"" . $hostid . "\\",\\"architecture\\":\\"" . $arch . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . $rosver . "\\",\\"agent_version\\":\\"" . $connver . "\\"}")
/tool fetch mode=https url=$enrollUrl http-method=post http-header-field="Content-Type:application/json" http-data=$body output=none
:log info "TECHI enrollment submitted: $hostid ($arch, RouterOS $rosver)"
}
"""

MIKROTIK_ROUTEROS_TEMPLATE = MIKROTIK_ROUTEROS7_TEMPLATE


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
    # Deployment metadata (additive; agent platforms leave these empty and are
    # unaffected). The deployment UI + script generation read ONLY these.
    deployment_method: str = ""                    # e.g. "routeros_script"
    deployment_template: str = ""                  # script template with {{PLACEHOLDERS}}
    deployment_templates_by_version: Mapping[str, str] = field(default_factory=dict)
    supported_architectures: Tuple[str, ...] = ()  # empty = not arch-validated
    supported_routeros_versions: Tuple[str, ...] = ()


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
            deployment_method="routeros_script",
            deployment_template=MIKROTIK_ROUTEROS_TEMPLATE,
            deployment_templates_by_version={
                "6": MIKROTIK_ROUTEROS6_TEMPLATE,
                "7": MIKROTIK_ROUTEROS7_TEMPLATE,
            },
            supported_architectures=("chr", "x86", "arm", "arm64", "mipsbe", "mmips", "ppc", "tile"),
            supported_routeros_versions=("6", "7"),
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


def render_deployment_script(
    platform_id: str,
    *,
    token: str,
    api_endpoint: str,
    version: str,
    routeros_version: Optional[str] = None,
) -> str:
    """Fill a platform's registry deployment_template with the enrollment token,
    API endpoint, platform id and connector version. The template is the single
    source of truth — the UI never hardcodes a script."""
    descriptor = PLATFORM_REGISTRY.get(str(platform_id).strip().lower())
    if descriptor is None or not descriptor.deployment_template:
        raise ValueError(f"Platform '{platform_id}' has no deployment template")
    template = descriptor.deployment_template
    if routeros_version is not None:
        ros_major = str(routeros_version).strip().lower().removeprefix("routeros").strip().split(".", 1)[0]
        if ros_major not in descriptor.supported_routeros_versions:
            raise ValueError(
                f"Unsupported {descriptor.display_name} RouterOS version: {routeros_version!r}. "
                f"Supported: {', '.join(descriptor.supported_routeros_versions)}"
            )
        template = descriptor.deployment_templates_by_version.get(ros_major, template)
    return (
        template
        .replace("{{TOKEN}}", token)
        .replace("{{API_ENDPOINT}}", api_endpoint.rstrip("/"))
        .replace("{{PLATFORM}}", descriptor.id)
        .replace("{{VERSION}}", version)
    )


def validate_architecture(platform_id: str, architecture: Optional[str]) -> str:
    """Validate a reported architecture against the platform's declared set.
    Returns the normalized arch. Raises ValueError for an unknown/absent arch when
    the platform declares supported_architectures (e.g. MikroTik). Platforms with
    no declared set (agent platforms) are not arch-validated."""
    descriptor = PLATFORM_REGISTRY.get(str(platform_id).strip().lower())
    if descriptor is None or not descriptor.supported_architectures:
        return (architecture or "").strip().lower()
    arch = (architecture or "").strip().lower()
    if arch not in descriptor.supported_architectures:
        raise ValueError(
            f"Unsupported {descriptor.display_name} architecture: {architecture!r}. "
            f"Supported: {', '.join(descriptor.supported_architectures)}"
        )
    return arch
