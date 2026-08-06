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

# Menu grouping (approved V3 Connect mockup): the Connect menu renders methods
# in fixed category sections — Recommended (the effective default, extracted at
# render time) · Available (embedded methods that run inside TECHI) · Web
# (browser surfaces) · Desktop Applications (local desktop apps) · Unavailable
# (feature-gated methods that can't run for this device right now). The
# registry declares each method's static kind; Recommended/Unavailable are
# derived per-device/per-operator, never stored here.
CATEGORY_AVAILABLE = "available"
CATEGORY_WEB = "web"
CATEGORY_DESKTOP_APP = "desktop_app"


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
    # ssh, and Winbox, which has a native macOS build). When set, the method
    # stays VISIBLE on other systems but is disabled with an explicit
    # "Unavailable on this operating system" reason (approved V3 Connect
    # mockup: never silently hide a method).
    requires_client_os: Optional[str] = None
    # Short transport/source label rendered under the method name in the menu
    # ("Agent tunnel", "Backend relay · Vault", "Browser", "Desktop app").
    transport: str = ""
    # Static menu section kind (CATEGORY_*), see the note above.
    category: str = CATEGORY_AVAILABLE
    # True when the method runs INSIDE TECHI on the Terminal stack (Embedded
    # Terminal / Embedded SSH) — usable only where FEATURE_TERMINAL + its
    # rollout scope cover the device, which /connect-methods reflects as an
    # honest "unavailable" status instead of a method that fails on click.
    embedded: bool = False


# Keyed by platform id. Ordered by priority within each platform.
CONNECT_METHODS: Dict[str, Tuple[ConnectMethod, ...]] = {
    "windows": (
        ConnectMethod("remote_support", "TECHI Remote Support", SURFACE_DESKTOP, None, 10,
                      transport="RustDesk", category=CATEGORY_DESKTOP_APP),
    ),
    "linux": (
        ConnectMethod("web_terminal", "Embedded Terminal", SURFACE_BROWSER, "terminal", 10,
                      transport="Agent tunnel", category=CATEGORY_AVAILABLE, embedded=True),
        ConnectMethod("ssh", "Embedded SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://",
                      transport="Backend relay · Vault", category=CATEGORY_AVAILABLE, embedded=True),
        ConnectMethod("remote_support", "TECHI Remote Support", SURFACE_DESKTOP, "remote_support", 30,
                      transport="RustDesk", category=CATEGORY_DESKTOP_APP),
    ),
    # MikroTik priorities encode the approved defaults: Winbox first (the
    # default for Windows operators), Embedded SSH before WebFig so that a
    # macOS/Linux operator (where Winbox is unavailable) defaults to Embedded
    # SSH when it's Ready and falls back to WebFig otherwise.
    "mikrotik": (
        # No requires_client_os: Winbox 4 ships a native macOS build and
        # operators here use it on both Windows and macOS, so gating the link to
        # Windows disabled the method for half the operators who can actually
        # run it.
        ConnectMethod("winbox", "Winbox", SURFACE_DESKTOP, None, 10, scheme="winbox://",
                      transport="Desktop app",
                      category=CATEGORY_DESKTOP_APP),
        ConnectMethod("ssh", "Embedded SSH", SURFACE_DESKTOP, "connect", 20, scheme="ssh://",
                      transport="Backend relay · Vault", category=CATEGORY_AVAILABLE, embedded=True),
        ConnectMethod("webfig", "WebFig", SURFACE_BROWSER, None, 30, web_path="/webfig/",
                      transport="Browser", category=CATEGORY_WEB),
    ),
    "synology": (
        ConnectMethod("dsm", "DSM", SURFACE_BROWSER, None, 10,
                      transport="Browser", category=CATEGORY_WEB),
        ConnectMethod("ssh", "Embedded SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://",
                      transport="Backend relay · Vault", category=CATEGORY_AVAILABLE, embedded=True),
    ),
    "qnap": (
        ConnectMethod("qts", "QTS", SURFACE_BROWSER, None, 10,
                      transport="Browser", category=CATEGORY_WEB),
        ConnectMethod("ssh", "Embedded SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://",
                      transport="Backend relay · Vault", category=CATEGORY_AVAILABLE, embedded=True),
    ),
    "vmware": (
        ConnectMethod("vsphere", "vSphere", SURFACE_BROWSER, None, 10,
                      transport="Browser", category=CATEGORY_WEB),
        ConnectMethod("ssh", "Embedded SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://",
                      transport="Backend relay · Vault", category=CATEGORY_AVAILABLE, embedded=True),
    ),
    "proxmox": (
        ConnectMethod("web_ui", "Web UI", SURFACE_BROWSER, None, 10,
                      transport="Browser", category=CATEGORY_WEB),
        ConnectMethod("ssh", "Embedded SSH", SURFACE_DESKTOP, "terminal", 20, scheme="ssh://",
                      transport="Backend relay · Vault", category=CATEGORY_AVAILABLE, embedded=True),
        ConnectMethod("web_terminal", "Embedded Terminal", SURFACE_BROWSER, "terminal", 30,
                      transport="Agent tunnel", category=CATEGORY_AVAILABLE, embedded=True),
    ),
    "hyperv": (
        ConnectMethod("remote_support", "TECHI Remote Support", SURFACE_DESKTOP, None, 10,
                      transport="RustDesk", category=CATEGORY_DESKTOP_APP),
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
