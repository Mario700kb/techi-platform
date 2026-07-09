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

# MikroTik RouterOS connector template. The router registers once via the
# generic /agent/enroll endpoint and installs two scheduled RouterOS scripts:
# a lightweight heartbeat and a slower inventory collection. This is still a
# Platform Connector, not a Windows/Linux native agent and not RouterOS API
# management. Placeholders ({{...}}) are filled server-side from the Platform
# Registry and Agent Config.
MIKROTIK_ROUTEROS_BASE_TEMPLATE = """# TECHI Platform - MikroTik enrollment (RouterOS {{ROUTEROS_VERSION_LABEL}})
# Paste into RouterOS terminal (or import as a script). Requires outbound HTTPS.
{
:global techiToken "{{TOKEN}}"
:global techiApi "{{API_ENDPOINT}}"
:global techiPlatform "{{PLATFORM}}"
:global techiConnectorVersion "{{VERSION}}"
:global techiHeartbeatInterval "{{HEARTBEAT_INTERVAL}}s"
:global techiInventoryInterval "{{INVENTORY_INTERVAL}}s"
:global techiAgentId
:local arch [/system resource get architecture-name]
:local rosver [/system resource get version]
:local hostid [/system identity get name]
:local serial ""
:do { :set serial [/system routerboard get serial-number] } on-error={}
:if ($serial = "") do={ :do { :set serial [/system license get software-id] } on-error={} }
:if ($serial = "") do={ :error "TECHI connector requires RouterOS serial-number or software-id" }
:set techiAgentId ("mikrotik-" . $serial)
:local enrollUrl ($techiApi . "/api/v1/agent/enroll")
:local body ("{\\"agent_id\\":\\"" . $techiAgentId . "\\",\\"enrollment_token\\":\\"" . $techiToken . "\\",\\"platform\\":\\"" . $techiPlatform . "\\",\\"hostname\\":\\"" . $hostid . "\\",\\"architecture\\":\\"" . $arch . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . $rosver . "\\",\\"agent_version\\":\\"" . $techiConnectorVersion . "\\"}")
/tool fetch mode=https url=$enrollUrl http-method=post http-header-field="Content-Type:application/json" http-data=$body {{FETCH_RESULT}}
/system scheduler remove [find name="TECHI-Heartbeat"]
/system scheduler remove [find name="TECHI-Inventory"]
/system script remove [find name="TECHI-Heartbeat"]
/system script remove [find name="TECHI-Inventory"]
/system script add name="TECHI-Heartbeat" policy=read,write,test source={
:global techiApi
:global techiPlatform
:global techiConnectorVersion
:global techiAgentId
:local arch [/system resource get architecture-name]
:local rosver [/system resource get version]
:local hostid [/system identity get name]
:local localip ""
:do { :local addrs [/ip address find where disabled=no]; :if ([:len $addrs] > 0) do={ :set localip [/ip address get [:pick $addrs 0] address] } } on-error={}
:local slash [:find $localip "/"]
:if ($slash != nil) do={ :set localip [:pick $localip 0 $slash] }
:local mac ""
:do { :local ports [/interface ethernet find where disabled=no]; :if ([:len $ports] > 0) do={ :set mac [/interface ethernet get [:pick $ports 0] mac-address] } } on-error={}
:local hbUrl ($techiApi . "/api/v1/agent/heartbeat")
:local hb ("{\\"agent_id\\":\\"" . $techiAgentId . "\\",\\"platform\\":\\"" . $techiPlatform . "\\",\\"hostname\\":\\"" . $hostid . "\\",\\"architecture\\":\\"" . $arch . "\\",\\"mac_address\\":\\"" . $mac . "\\",\\"local_ip\\":\\"" . $localip . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . $rosver . "\\",\\"agent_version\\":\\"" . $techiConnectorVersion . "\\",\\"capabilities\\":[\\"interfaces\\",\\"routes\\",\\"firewall\\",\\"wireless\\",\\"bridge\\",\\"dhcp\\",\\"dns\\",\\"logs\\",\\"packages\\",\\"identity\\",\\"system\\",\\"connect\\"]}")
/tool fetch mode=https url=$hbUrl http-method=post http-header-field="Content-Type:application/json" http-data=$hb {{FETCH_RESULT}}
:log info ("TECHI heartbeat submitted: " . $hostid)
}
/system script add name="TECHI-Inventory" policy=read,write,test source={
:global techiApi
:global techiPlatform
:global techiConnectorVersion
:global techiAgentId
:local arch [/system resource get architecture-name]
:local rosver [/system resource get version]
:local hostid [/system identity get name]
:local model ""
:local serial ""
:local firmware ""
:do { :set model [/system routerboard get model] } on-error={}
:do { :set serial [/system routerboard get serial-number] } on-error={}
:if ($serial = "") do={ :do { :set serial [/system license get software-id] } on-error={} }
:do { :set firmware [/system routerboard get current-firmware] } on-error={}
:local cpu [/system resource get cpu]
:local ram [/system resource get total-memory]
:local freehdd [/system resource get free-hdd-space]
:local totalhdd [/system resource get total-hdd-space]
:local uptime [/system resource get uptime]
:local localip ""
:do { :local addrs [/ip address find where disabled=no]; :if ([:len $addrs] > 0) do={ :set localip [/ip address get [:pick $addrs 0] address] } } on-error={}
:local slash [:find $localip "/"]
:if ($slash != nil) do={ :set localip [:pick $localip 0 $slash] }
:local mac ""
:do { :local ports [/interface ethernet find where disabled=no]; :if ([:len $ports] > 0) do={ :set mac [/interface ethernet get [:pick $ports 0] mac-address] } } on-error={}
:local defgw ""
:do { :local routes [/ip route find where dst-address="0.0.0.0/0"]; :if ([:len $routes] > 0) do={ :set defgw [/ip route get [:pick $routes 0] gateway] } } on-error={}
:local dns ""
:do { :set dns [/ip dns get servers] } on-error={}
:local bridgeCount "0"
:do { :set bridgeCount [:len [/interface bridge find]] } on-error={}
:local wirelessCount "0"
:do { :set wirelessCount [:len [/interface wireless find]] } on-error={}
:local services "["
:local first true
:foreach i in=[/interface find] do={ :local name [/interface get $i name]; :local running [/interface get $i running]; :local status "down"; :if ($running = true) do={ :set status "up" }; :if ($first = false) do={ :set services ($services . ",") }; :set first false; :set services ($services . "{\\"name\\":\\"" . $name . "\\",\\"display_name\\":\\"" . $name . "\\",\\"status\\":\\"" . $status . "\\"}") }
:set services ($services . "]")
:local packages "[{\\"name\\":\\"RouterOS\\",\\"version\\":\\"" . $rosver . "\\"},{\\"name\\":\\"RouterBOOT\\",\\"version\\":\\"" . $firmware . "\\"}]"
:do { :foreach p in=[/system package find] do={ :local pname [/system package get $p name]; :local pver [/system package get $p version]; :set packages ([:pick $packages 0 ([:len $packages] - 1)] . ",{\\"name\\":\\"" . $pname . "\\",\\"version\\":\\"" . $pver . "\\"}]") } } on-error={}
:local hbUrl ($techiApi . "/api/v1/agent/heartbeat")
:local caption ("Board=" . $model . "; Model=" . $model . "; Serial=" . $serial . "; Firmware=" . $firmware . "; Uptime=" . $uptime . "; DefaultRoute=" . $defgw . "; DNS=" . $dns . "; Bridges=" . $bridgeCount . "; Wireless=" . $wirelessCount)
:local storage ("free=" . $freehdd . "; total=" . $totalhdd)
:local hb ("{\\"agent_id\\":\\"" . $techiAgentId . "\\",\\"platform\\":\\"" . $techiPlatform . "\\",\\"hostname\\":\\"" . $hostid . "\\",\\"architecture\\":\\"" . $arch . "\\",\\"mac_address\\":\\"" . $mac . "\\",\\"local_ip\\":\\"" . $localip . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . $rosver . "\\",\\"os_caption\\":\\"" . $caption . "\\",\\"agent_version\\":\\"" . $techiConnectorVersion . "\\",\\"cpu\\":\\"" . $cpu . "\\",\\"ram\\":\\"" . $ram . "\\",\\"storage\\":\\"" . $storage . "\\",\\"capabilities\\":[\\"interfaces\\",\\"routes\\",\\"firewall\\",\\"wireless\\",\\"bridge\\",\\"dhcp\\",\\"dns\\",\\"logs\\",\\"packages\\",\\"identity\\",\\"system\\",\\"connect\\"],\\"services\\":" . $services . ",\\"software\\":" . $packages . "}")
/tool fetch mode=https url=$hbUrl http-method=post http-header-field="Content-Type:application/json" http-data=$hb {{FETCH_RESULT}}
:log info ("TECHI inventory submitted: " . $hostid)
}
/system scheduler add name="TECHI-Heartbeat" interval=$techiHeartbeatInterval on-event="TECHI-Heartbeat"
/system scheduler add name="TECHI-Inventory" interval=$techiInventoryInterval on-event="TECHI-Inventory"
/system script run "TECHI-Heartbeat"
/system script run "TECHI-Inventory"
:log info "TECHI connector installed: $hostid ($arch, RouterOS $rosver)"
}
"""

MIKROTIK_ROUTEROS6_TEMPLATE = (
    MIKROTIK_ROUTEROS_BASE_TEMPLATE
    .replace("{{ROUTEROS_VERSION_LABEL}}", "6.x")
    .replace("{{FETCH_RESULT}}", "keep-result=no")
)

MIKROTIK_ROUTEROS7_TEMPLATE = (
    MIKROTIK_ROUTEROS_BASE_TEMPLATE
    .replace("{{ROUTEROS_VERSION_LABEL}}", "7.x")
    .replace("{{FETCH_RESULT}}", "output=none")
)

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
            connect_methods=("winbox", "webfig", "ssh"),
            allowed_capabilities=frozenset(
                {
                    "interfaces",
                    "routes",
                    "firewall",
                    "wireless",
                    "bridge",
                    "dhcp",
                    "dns",
                    "logs",
                    "packages",
                    "identity",
                    "system",
                    "connect",
                }
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
    heartbeat_interval_seconds: int = 250,
    inventory_interval_seconds: int = 1800,
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
        .replace("{{HEARTBEAT_INTERVAL}}", str(int(heartbeat_interval_seconds)))
        .replace("{{INVENTORY_INTERVAL}}", str(int(inventory_interval_seconds)))
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
