"""Connect Framework (Platform Expansion Phase 7).

The single, capability-driven source of connection methods for every platform.
The Connect button/dropdown is generated ENTIRELY from this metadata + the
device's reported capabilities — never a hardcoded per-platform dropdown.

Adding a platform's connectivity = adding rows here (id, label, surface,
capability, priority, scheme/web_path). No UI change, no launcher change.

Availability rule: a method is available for a device iff the method belongs to
the device's platform AND (its `capability` is None OR that capability is in the
device's reported capabilities). Platform-native methods (Winbox, WebFig, DSM,
remote support…) use `capability=None`; generic methods key off real
capabilities. SSH is not Linux-only: Linux/storage platforms expose it through
`terminal`, while MikroTik exposes metadata-only SSH through `connect`.

Launchers: `GET /devices/{id}/connect-methods/{method_id}/launch`
(api/v1/endpoints/connect.py) builds a `scheme://<host>` or
`http://<host><web_path>` URL from the device's local/public IP — generic
for every platform, no per-platform launcher code. `remote_support` and
`web_terminal` are excluded (they have their own dedicated, already-audited
flows: `/remote-support/devices/{id}/connect-url` and the Terminal tab).
"""

from dataclasses import dataclass
from typing import Dict, Optional, Tuple

SURFACE_DESKTOP = "desktop"
SURFACE_BROWSER = "browser"


@dataclass(frozen=True)
class ConnectMethod:
    id: str
    label: str
    surface: str            # SURFACE_DESKTOP | SURFACE_BROWSER
    capability: Optional[str]  # required device capability, or None = platform-native
    priority: int           # lower = listed first / preferred default
    scheme: Optional[str] = None    # desktop launcher protocol, e.g. "winbox://", "ssh://"
    web_path: Optional[str] = None  # browser launcher path appended to http://<host>, e.g. "/webfig/"
    # OPERATOR's client OS this method's desktop app is available on, or None
    # if it works regardless (browser methods, cross-platform CLI tools like
    # ssh). Winbox.exe is Windows-only, so its winbox:// link is a dead click
    # on macOS/Linux — the frontend hides methods that don't match the
    # operator's detected OS instead of showing a launcher that can't work.
    requires_client_os: Optional[str] = None


# Keyed by platform id. Ordered by priority within each platform.
CONNECT_METHODS: Dict[str, Tuple[ConnectMethod, ...]] = {
    "windows": (
        ConnectMethod("remote_support", "TECHI Remote Support", SURFACE_DESKTOP, None, 10),
    ),
    "linux": (
        ConnectMethod("web_terminal", "Web Terminal", SURFACE_BROWSER, "terminal", 10),
        ConnectMethod("ssh", "SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://"),
        ConnectMethod("remote_support", "TECHI Remote Support", SURFACE_DESKTOP, "remote_support", 30),
    ),
    "mikrotik": (
        ConnectMethod("winbox", "Winbox", SURFACE_DESKTOP, None, 10, scheme="winbox://", requires_client_os="windows"),
        ConnectMethod("webfig", "WebFig", SURFACE_BROWSER, None, 20, web_path="/webfig/"),
        ConnectMethod("ssh", "SSH", SURFACE_DESKTOP, "connect", 30, scheme="ssh://"),
    ),
    "synology": (
        ConnectMethod("dsm", "DSM", SURFACE_BROWSER, None, 10),
        ConnectMethod("ssh", "SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://"),
    ),
    "qnap": (
        ConnectMethod("qts", "QTS", SURFACE_BROWSER, None, 10),
        ConnectMethod("ssh", "SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://"),
    ),
    "vmware": (
        ConnectMethod("vsphere", "vSphere", SURFACE_BROWSER, None, 10),
        ConnectMethod("ssh", "SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://"),
    ),
    "proxmox": (
        ConnectMethod("web_ui", "Web UI", SURFACE_BROWSER, None, 10),
        ConnectMethod("ssh", "SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://"),
        ConnectMethod("web_terminal", "Web Terminal", SURFACE_BROWSER, "terminal", 30),
    ),
    "hyperv": (
        ConnectMethod("remote_support", "TECHI Remote Support", SURFACE_DESKTOP, None, 10),
    ),
}


def methods_for(platform_id: str, capabilities: Optional[dict]) -> Tuple[ConnectMethod, ...]:
    """Available connect methods for a device, ordered by priority."""
    caps = capabilities or {}
    methods = CONNECT_METHODS.get(platform_id, ())
    available = [
        m for m in methods
        if m.capability is None or m.capability in caps
    ]
    return tuple(sorted(available, key=lambda m: m.priority))
