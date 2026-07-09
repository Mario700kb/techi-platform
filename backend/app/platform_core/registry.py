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

# MikroTik RouterOS connector template — deliberately SMALL. The router
# enrolls once via the generic /agent/enroll endpoint and installs two
# scheduled RouterOS scripts: a minimal heartbeat and a lightweight inventory.
# It is a Connector, NOT an agent: no loops, no enumeration (packages/
# interfaces/routes/firewall...), flat JSON only — advanced RouterOS work
# happens through Connect (Winbox/WebFig/SSH). Every possible calculation
# (public IP, health, classification, freshness) is done by the backend.
# The scheduled scripts are self-contained (no RouterOS globals) so they
# survive a reboot. Placeholders ({{...}}) are filled server-side from the
# Platform Registry and Agent Config.
MIKROTIK_ROUTEROS_BASE_TEMPLATE = """# TECHI Platform - MikroTik connector (RouterOS {{ROUTEROS_VERSION_LABEL}})
# Paste into RouterOS terminal (or import as a script). Requires outbound HTTPS.
{
:local serial ""
:do { :set serial [/system routerboard get serial-number] } on-error={}
:if ($serial = "") do={ :do { :set serial [/system license get software-id] } on-error={} }
:if ($serial = "") do={ :error "TECHI connector requires RouterOS serial-number or software-id" }
:local body ("{\\"agent_id\\":\\"mikrotik-" . $serial . "\\",\\"enrollment_token\\":\\"{{TOKEN}}\\",\\"platform\\":\\"{{PLATFORM}}\\",\\"hostname\\":\\"" . [/system identity get name] . "\\",\\"architecture\\":\\"" . [/system resource get architecture-name] . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . [/system resource get version] . "\\",\\"agent_version\\":\\"{{VERSION}}\\"}")
:do {
  /tool fetch mode=https url="{{API_ENDPOINT}}/api/v1/agent/enroll" http-method=post http-header-field="Content-Type:application/json" http-data=$body {{FETCH_RESULT}}
} on-error={
  :log error ("TECHI enrollment failed for mikrotik-" . $serial . " - check token/network, then re-run this script")
  :error "TECHI enrollment failed"
}
/system scheduler remove [find name="TECHI-Heartbeat"]
/system scheduler remove [find name="TECHI-Inventory"]
/system script remove [find name="TECHI-Heartbeat"]
/system script remove [find name="TECHI-Inventory"]
/system script add name="TECHI-Heartbeat" policy=read,write,test source={
:local serial ""
:do { :set serial [/system routerboard get serial-number] } on-error={}
:if ($serial = "") do={ :do { :set serial [/system license get software-id] } on-error={} }
:if ($serial = "") do={ :error "TECHI heartbeat: no serial-number or software-id" }
:local localip ""
:do { :local addrs [/ip address find where disabled=no]; :if ([:len $addrs] > 0) do={ :set localip [/ip address get [:pick $addrs 0] address] } } on-error={}
:local slash [:find $localip "/"]
:if ($slash != nil) do={ :set localip [:pick $localip 0 $slash] }
:local cpuPct 0
:do { :set cpuPct [/system resource get cpu-load] } on-error={}
:local ramPct 0
:do { :local rt [/system resource get total-memory]; :local ru ($rt / 100); :if ($ru > 0) do={ :set ramPct (($rt - [/system resource get free-memory]) / $ru) } } on-error={}
:local hb ("{\\"agent_id\\":\\"mikrotik-" . $serial . "\\",\\"platform\\":\\"{{PLATFORM}}\\",\\"hostname\\":\\"" . [/system identity get name] . "\\",\\"architecture\\":\\"" . [/system resource get architecture-name] . "\\",\\"local_ip\\":\\"" . $localip . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . [/system resource get version] . "\\",\\"agent_version\\":\\"{{VERSION}}\\",\\"cpu_percent\\":" . $cpuPct . ",\\"ram_percent\\":" . $ramPct . ",\\"capabilities\\":[\\"connect\\"]}")
/tool fetch mode=https url="{{API_ENDPOINT}}/api/v1/agent/heartbeat" http-method=post http-header-field="Content-Type:application/json" http-data=$hb {{FETCH_RESULT}}
}
/system script add name="TECHI-Inventory" policy=read,write,test source={
:local serial ""
:local board ""
:local model ""
:local fw ""
:do { :set serial [/system routerboard get serial-number]; :set board [/system routerboard get board-name]; :set model [/system routerboard get model]; :set fw [/system routerboard get current-firmware] } on-error={}
:if ($serial = "") do={ :do { :set serial [/system license get software-id] } on-error={} }
:if ($serial = "") do={ :error "TECHI inventory: no serial-number or software-id" }
:local bridges 0
:do { :set bridges [:len [/interface bridge find]] } on-error={}
:local wifi "no"
:do { :if ([:len [/interface wireless find]] > 0) do={ :set wifi "yes" } } on-error={}
:local defroute "no"
:do { :if ([:len [/ip route find where dst-address="0.0.0.0/0"]] > 0) do={ :set defroute "yes" } } on-error={}
:local caption ("Board=" . $board . "; Model=" . $model . "; Serial=" . $serial . "; Firmware=" . $fw . "; Uptime=" . [/system resource get uptime] . "; Bridges=" . $bridges . "; Wireless=" . $wifi . "; DefaultRoute=" . $defroute)
:local hddFree [/system resource get free-hdd-space]
:local hddTotal [/system resource get total-hdd-space]
:local diskPct 0
:do { :local hu ($hddTotal / 100); :if ($hu > 0) do={ :set diskPct (($hddTotal - $hddFree) / $hu) } } on-error={}
:local hb ("{\\"agent_id\\":\\"mikrotik-" . $serial . "\\",\\"platform\\":\\"{{PLATFORM}}\\",\\"hostname\\":\\"" . [/system identity get name] . "\\",\\"architecture\\":\\"" . [/system resource get architecture-name] . "\\",\\"os_name\\":\\"RouterOS\\",\\"os_version\\":\\"" . [/system resource get version] . "\\",\\"os_caption\\":\\"" . $caption . "\\",\\"agent_version\\":\\"{{VERSION}}\\",\\"cpu\\":\\"" . [/system resource get cpu] . "\\",\\"ram\\":\\"" . [/system resource get total-memory] . "\\",\\"storage\\":\\"free=" . $hddFree . "; total=" . $hddTotal . "\\",\\"disk_percent\\":" . $diskPct . ",\\"capabilities\\":[\\"connect\\"],\\"software\\":[{\\"name\\":\\"RouterOS\\",\\"version\\":\\"" . [/system resource get version] . "\\"},{\\"name\\":\\"RouterBOOT\\",\\"version\\":\\"" . $fw . "\\"}]}")
/tool fetch mode=https url="{{API_ENDPOINT}}/api/v1/agent/heartbeat" http-method=post http-header-field="Content-Type:application/json" http-data=$hb {{FETCH_RESULT}}
}
/system scheduler add name="TECHI-Heartbeat" interval={{HEARTBEAT_INTERVAL}}s on-event="TECHI-Heartbeat"
/system scheduler add name="TECHI-Inventory" interval={{INVENTORY_INTERVAL}}s on-event="TECHI-Inventory"
/system script run "TECHI-Heartbeat"
/system script run "TECHI-Inventory"
:log info ("TECHI connector installed: mikrotik-" . $serial)
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
            # Connector philosophy: MikroTik reports ONLY what the dashboard
            # needs. `connect` gates the metadata-only Connect surface; no
            # agent-style capability tabs — advanced work happens in
            # Winbox/WebFig/SSH.
            allowed_capabilities=frozenset({"connect"}),
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
