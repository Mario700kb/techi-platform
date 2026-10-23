"""Public Linux installer script (Platform Expansion Phase 2, flag-gated).

`GET /install/linux?token=<enrollment_token>` returns a bash one-liner
installer, fetched on the target with:

    curl -fsSL https://api-rdp.techi.com.al/api/v1/install/linux?token=TKN | sudo bash

It is intentionally unauthenticated (curl on a fresh host has no operator JWT);
the enrollment token is the credential, so it must be short-lived / low-max-use
(the NETLOGON plaintext-token lesson). With FEATURE_LINUX off the route 404s.
"""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse

from app.core.config import settings
from app.platform_core.flags import feature_enabled
from app.services import agent_config_service as _agent_cfg

router = APIRouter()


def _public_base() -> str:
    return (settings.PUBLIC_BACKEND_URL or "https://api-rdp.techi.com.al").rstrip("/")


def _ws_base(base: str) -> str:
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):]
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):]
    return base


def _linux_checksums() -> str:
    """A shell `case` mapping each Linux architecture to its package SHA-256.

    Embedded so the target verifies what it downloaded instead of trusting the
    transfer. An architecture with no active package yields an empty value and
    the script says so rather than silently skipping the check.
    """
    from app.services.agent_package_service import AgentPackageService

    service = AgentPackageService()
    lines = []
    for arch in ("amd64", "arm64", "armhf"):
        package = service.latest_active(f"linux-{arch}", file_type="agent_binary")
        checksum = (package.sha256 or "") if package else ""
        lines.append(f'    {arch}) EXPECTED_SHA256="{checksum}" ;;')
    return "\n".join(lines)


# TECHI Remote Support on Linux is upstream RustDesk, pinned to the version the
# Windows fleet runs and checked against the SHA-256 GitHub publishes for each
# asset, one package per package manager and architecture. There is no armv6
# build: a Pi Zero/1 gets the terminal only, and so does a distribution or
# architecture missing below.
RUSTDESK_LINUX_VERSION = "1.4.6"
RUSTDESK_LINUX_PACKAGES = {
    ("deb", "amd64"): ("rustdesk-1.4.6-x86_64.deb", "0da46d7a7b252282ded5323f74319a10c1fa7271001d3b297b3def415c8c8f04"),
    ("deb", "arm64"): ("rustdesk-1.4.6-aarch64.deb", "d767b042c53a169f4bc6273d884a238fc44501a9fda2095fb05820dfc538b34c"),
    ("deb", "armhf"): ("rustdesk-1.4.6-armv7-sciter.deb", "c573774c7bd47b80d816f453c080e1f0eb22901f8fb868d69359f088c049451d"),
    ("rpm", "amd64"): ("rustdesk-1.4.6-0.x86_64.rpm", "8986df89ed20401944f77be45ed389855ba5fb6611861718a00a0cfe146822d5"),
    ("rpm", "arm64"): ("rustdesk-1.4.6-0.aarch64.rpm", "3255ba6007f2b00295c38a9d9c8b8d9d4edc7e7755e451b4fc1f83595962fed1"),
    ("suse", "amd64"): ("rustdesk-1.4.6-0.x86_64-suse.rpm", "76677500275cf73acc7fa69b1276a50d4af5fd317ad2e18b2cecdfc64e37536a"),
    ("suse", "arm64"): ("rustdesk-1.4.6-0.aarch64-suse.rpm", "cb0893417e97bd9d0585b634b8d220066d9c0ec38229f4e72ce770f16814756d"),
    ("arch", "amd64"): ("rustdesk-1.4.6-0-x86_64.pkg.tar.zst", "d3eb57735b3f9ea919bc58795e9f2bf6420b0cf80af55647c63697d6fb22c9b8"),
}


def _rustdesk_packages() -> str:
    """A shell `case` mapping package manager + architecture to RustDesk's package and SHA-256."""
    return "\n".join(
        f'    {fmt}-{arch}) RS_PKG="{pkg}"; RS_SHA256="{sha}" ;;'
        for (fmt, arch), (pkg, sha) in RUSTDESK_LINUX_PACKAGES.items()
    )


@router.get("/linux", response_class=PlainTextResponse)
def linux_installer(token: str = Query(..., min_length=1)) -> PlainTextResponse:
    if not feature_enabled("FEATURE_LINUX"):
        raise HTTPException(status_code=404, detail="Not Found")

    base = _public_base()
    ws = _ws_base(base)
    checksums = _linux_checksums()
    heartbeat = _agent_cfg.get_heartbeat_interval("linux")
    rustdesk_packages = _rustdesk_packages()
    rs_host = settings.RUSTDESK_SERVER_HOST
    rs_relay = settings.RUSTDESK_RELAY_HOST
    rs_key = settings.RUSTDESK_PUBLIC_KEY
    # The token is echoed into the script the operator generated; it is not a
    # secret to the backend. Keep it out of logs by not logging the query.
    script = f"""#!/usr/bin/env bash
set -euo pipefail

# TECHI Linux Agent installer (Platform Expansion Phase 2)
#
# Safe to re-run on a host that already has the agent: it upgrades the binary
# and leaves the existing configuration — and therefore the device's identity —
# untouched. Only a host with no configuration is enrolled.
BACKEND="{base}"
TOKEN="{token}"
BIN_PATH="/usr/local/bin/techi-agent"
CONFIG_DIR="/etc/techi-agent"
CONFIG_PATH="${{CONFIG_DIR}}/agent.config.json"
SERVICE="techi-agent"

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root (use sudo)." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l|armv6l|armhf) ARCH="armhf" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Everything that can stop the install is checked here, before anything on
# the machine is touched. The agent runs as a systemd service: a machine
# without systemd as PID 1 (Alpine, Devuan, a container) is refused cleanly
# instead of halfway, after the binary was already replaced.
if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "This installer needs systemd, and this machine does not run it - nothing was changed." >&2
  echo "  Supported: Debian, Ubuntu, Raspberry Pi OS, Mint, RHEL, Rocky, Alma, Fedora, openSUSE, Arch and other systemd distributions." >&2
  exit 1
fi

EXPECTED_SHA256=""
case "${{ARCH}}" in
{checksums}
esac
if [ -z "${{EXPECTED_SHA256}}" ]; then
  echo "No TECHI agent package is active for linux-${{ARCH}} - nothing was changed." >&2
  echo "  Activate one under Onboarding -> Packages, then run this again." >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is missing, so the download cannot be verified - nothing was changed." >&2
  exit 1
fi

TMP_BIN="$(mktemp /tmp/techi-agent-XXXXXX)"
BACKUP=""
cleanup() {{ rm -f "${{TMP_BIN}}"; }}
trap cleanup EXIT

# A minimal Debian install ships neither curl nor wget, and whichever fetched
# this script is not necessarily present for the binary download too.
fetch() {{
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "Neither curl nor wget is available; cannot download the agent." >&2
    echo "  Debian/Ubuntu: apt-get install -y curl" >&2
    echo "  RHEL/Fedora:   dnf install -y curl" >&2
    exit 1
  fi
}}

# Download BEFORE stopping anything, so a failed download costs no downtime.
echo "Downloading TECHI agent (linux-${{ARCH}})..."
fetch "${{BACKEND}}/api/v1/agent-packages/platform/linux-${{ARCH}}/download" "${{TMP_BIN}}"

ACTUAL_SHA256="$(sha256sum "${{TMP_BIN}}" | cut -d ' ' -f 1)"
if [ "${{ACTUAL_SHA256}}" != "${{EXPECTED_SHA256}}" ]; then
  echo "Checksum mismatch - refusing to install." >&2
  echo "  expected: ${{EXPECTED_SHA256}}" >&2
  echo "  actual:   ${{ACTUAL_SHA256}}" >&2
  exit 1
fi
echo "Checksum verified."

# A running executable cannot be overwritten - the kernel returns ETXTBSY and
# curl/install fail. Stopping first is what makes re-running this work at all.
RESTART_NEEDED=0
if systemctl is-active --quiet "${{SERVICE}}" 2>/dev/null; then
  echo "Stopping ${{SERVICE}}..."
  systemctl stop "${{SERVICE}}"
  RESTART_NEEDED=1
fi

if [ -f "${{BIN_PATH}}" ]; then
  BACKUP="${{BIN_PATH}}.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "${{BIN_PATH}}" "${{BACKUP}}"
fi

if ! install -m 0755 -o root -g root "${{TMP_BIN}}" "${{BIN_PATH}}"; then
  echo "Install failed; restoring previous binary." >&2
  [ -n "${{BACKUP}}" ] && cp -p "${{BACKUP}}" "${{BIN_PATH}}"
  [ "${{RESTART_NEEDED}}" = "1" ] && systemctl start "${{SERVICE}}" || true
  exit 1
fi

# The agent's identity (agent_id, device_id) lives in this file. Overwriting it
# would force a re-enrolment and can attach the machine to a different device
# record. An already-enrolled agent skips enrolment entirely, so keeping the
# file is what makes an upgrade safe.
ENROLLED=0
if [ -f "${{CONFIG_PATH}}" ]; then
  echo "Existing configuration found - keeping it (device identity preserved)."
  if grep -Eq '"agent_id"[[:space:]]*:[[:space:]]*"[^"]+"' "${{CONFIG_PATH}}"; then
    ENROLLED=1
  fi
else
  mkdir -p "${{CONFIG_DIR}}"
  cat > "${{CONFIG_PATH}}" <<JSON
{{
  "backend_url": "${{BACKEND}}/api/v1/agent/heartbeat",
  "api_url": "${{BACKEND}}",
  "websocket_url": "{ws}/ws/devices",
  "public_ip_service": "https://api.ipify.org",
  "timeout_seconds": 30,
  "heartbeat_interval_seconds": {heartbeat},
  "retries": 3,
  "retry_delay_seconds": 5
}}
JSON
  chmod 600 "${{CONFIG_PATH}}"
fi

# --- TECHI Remote Support -------------------------------------------------
# Remote Support shares the screen, so only a machine with a desktop gets it;
# a server keeps the terminal. Re-running keeps its ID: only the package and
# the ID server options are put back. A failure here never undoes the agent.
# It runs BEFORE the agent starts, so the device's first heartbeat already
# carries Remote Support and its ID: Connect never meets a desktop that shows
# only the terminal while RustDesk is still being installed.
RS_VERSION="{RUSTDESK_LINUX_VERSION}"
RS_FORMAT=""
if command -v apt-get >/dev/null 2>&1 && command -v dpkg-query >/dev/null 2>&1; then
  RS_FORMAT="deb"
elif command -v zypper >/dev/null 2>&1; then
  RS_FORMAT="suse"
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  RS_FORMAT="rpm"
elif command -v pacman >/dev/null 2>&1; then
  RS_FORMAT="arch"
fi
# The package follows the userland, not the kernel: 32-bit Raspberry Pi OS on
# a Pi 4/5 runs a 64-bit kernel (aarch64) under armhf packages.
RS_ARCH="${{ARCH}}"
if [ "${{RS_FORMAT}}" = "deb" ]; then
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64) RS_ARCH="amd64" ;;
    arm64) RS_ARCH="arm64" ;;
    armhf) RS_ARCH="armhf" ;;
  esac
fi
RS_PKG=""
RS_SHA256=""
case "${{RS_FORMAT}}-${{RS_ARCH}}" in
{rustdesk_packages}
esac
RS_OPTIONS="/root/.config/rustdesk/RustDesk2.toml"

has_desktop() {{
  [ "$(systemctl get-default 2>/dev/null)" = "graphical.target" ] && return 0
  for dm in lightdm gdm gdm3 sddm lxdm xdm; do
    systemctl is-active --quiet "${{dm}}" 2>/dev/null && return 0
  done
  return 1
}}

rs_installed_version() {{
  case "${{RS_FORMAT}}" in
    deb) dpkg-query -W -f='${{Status}} ${{Version}}' rustdesk 2>/dev/null | sed -n 's/^install ok installed //p' ;;
    rpm|suse) rpm -q rustdesk >/dev/null 2>&1 && rpm -q --qf '%{{VERSION}}' rustdesk ;;
    arch) pacman -Q rustdesk 2>/dev/null | cut -d ' ' -f 2 ;;
  esac
}}

rs_install_package() {{
  case "${{RS_FORMAT}}" in
    deb)
      DEBIAN_FRONTEND=noninteractive apt-get install -y "$1" \\
        || {{ apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y "$1"; }} ;;
    rpm)
      if command -v dnf >/dev/null 2>&1; then dnf install -y "$1"; else yum install -y "$1"; fi \\
        || {{ echo "  On RHEL/Rocky/Alma a missing library usually comes from EPEL: dnf install -y epel-release, then run this again." >&2; return 1; }} ;;
    suse) zypper --non-interactive install --allow-unsigned-rpm "$1" ;;
    arch) pacman -U --noconfirm "$1" ;;
    *) return 1 ;;
  esac
}}

install_remote_support() {{
  # An installed RustDesk is kept whatever its version (a package manager
  # refuses to go back to 1.4.6 from a newer one); it only gets pointed at
  # the platform.
  RS_INSTALLED="$(rs_installed_version || true)"
  if [ -n "${{RS_INSTALLED}}" ]; then
    echo "TECHI Remote Support ${{RS_INSTALLED}} already installed - keeping it."
  else
    RS_TMP="$(mktemp -d /tmp/techi-rs-XXXXXX)" || return 1
    chmod 755 "${{RS_TMP}}"
    echo "Downloading TECHI Remote Support ${{RS_VERSION}} (${{RS_PKG}})..."
    fetch "https://github.com/rustdesk/rustdesk/releases/download/${{RS_VERSION}}/${{RS_PKG}}" "${{RS_TMP}}/${{RS_PKG}}" || return 1
    if [ "$(sha256sum "${{RS_TMP}}/${{RS_PKG}}" | cut -d ' ' -f 1)" != "${{RS_SHA256}}" ]; then
      echo "Remote Support checksum mismatch - not installing it." >&2
      rm -rf "${{RS_TMP}}"
      return 1
    fi
    chmod 644 "${{RS_TMP}}/${{RS_PKG}}"
    rs_install_package "${{RS_TMP}}/${{RS_PKG}}" || {{ rm -rf "${{RS_TMP}}"; return 1; }}
    rm -rf "${{RS_TMP}}"
  fi

  # The platform's own ID server, and the platform as api-server so every
  # session is reported, exactly as on Windows. Only these keys are replaced.
  systemctl stop rustdesk 2>/dev/null || true
  mkdir -p "$(dirname "${{RS_OPTIONS}}")"
  if [ -f "${{RS_OPTIONS}}" ] && grep -q '^\\[options\\]' "${{RS_OPTIONS}}"; then
    sed -i -e '/^custom-rendezvous-server *=/d' -e '/^relay-server *=/d' \\
      -e '/^api-server *=/d' -e '/^key *=/d' "${{RS_OPTIONS}}"
    sed -i -e "/^\\[options\\]/a custom-rendezvous-server = '{rs_host}'" \\
      -e "/^\\[options\\]/a relay-server = '{rs_relay}'" \\
      -e "/^\\[options\\]/a api-server = '${{BACKEND}}'" \\
      -e "/^\\[options\\]/a key = '{rs_key}'" "${{RS_OPTIONS}}"
  else
    cat > "${{RS_OPTIONS}}" <<TOML
rendezvous_server = ''
nat_type = 1
serial = 0

[options]
custom-rendezvous-server = '{rs_host}'
relay-server = '{rs_relay}'
api-server = '${{BACKEND}}'
key = '{rs_key}'
TOML
  fi
  systemctl enable rustdesk >/dev/null 2>&1 || true
  systemctl restart rustdesk || return 1
  # The same options through RustDesk's own CLI, which stores them the way the
  # installed version expects: the file above alone did not make the Pis
  # register with the platform's ID server ("ID does not exist"). `--option`
  # hands them to the RUNNING service. On a fresh install the service needs
  # a while (first start makes its keys) and an early `--option` is lost:
  # the installer had to be run twice. So: wait until RustDesk answers, set,
  # restart, read the ID server back, and go round again until it is ours.
  rs_option() {{ timeout 15 rustdesk --option "$1" "$2" >/dev/null 2>&1 || true; }}
  rs_answers() {{ timeout 10 rustdesk --get-id 2>/dev/null | tr -d ' ' | grep -qE '^[0-9]{{6,}}$'; }}
  RS_SERVER=""
  for RS_PASS in 1 2 3 4 5; do
    for _ in $(seq 1 20); do rs_answers && break; sleep 3; done
    sleep 3
    rs_option custom-rendezvous-server '{rs_host}'
    rs_option relay-server '{rs_relay}'
    rs_option api-server "${{BACKEND}}"
    rs_option key '{rs_key}'
    systemctl restart rustdesk || return 1
    for _ in $(seq 1 20); do rs_answers && break; sleep 3; done
    RS_SERVER="$(timeout 15 rustdesk --option custom-rendezvous-server 2>/dev/null | tr -d ' ' | tail -n 1)"
    # Twice at least: the second pass is what a second run of the installer
    # used to do, on a service that is surely up.
    if [ "${{RS_SERVER}}" = '{rs_host}' ] && [ "${{RS_PASS}}" -ge 2 ]; then
      break
    fi
  done
  if [ "${{RS_SERVER}}" != '{rs_host}' ]; then
    echo "Warning: Remote Support reports ID server '${{RS_SERVER}}', not '{rs_host}'. Run the installer again." >&2
  fi
  RS_ID="$(timeout 15 rustdesk --get-id 2>/dev/null | tr -d ' ' | grep -E '^[0-9]{{6,}}$' | head -n 1)"
  if [ -n "${{RS_ID}}" ]; then
    echo "TECHI Remote Support installed. ID: ${{RS_ID}}"
  else
    echo "TECHI Remote Support installed; the agent reports its ID with its first heartbeat."
  fi

  # Unattended access needs X11; on Wayland every session waits for a click.
  # GNOME (Ubuntu 22.04+, Debian 12+, Fedora, RHEL 9) logs in on Wayland
  # unless GDM is told otherwise, even before anyone has logged in.
  RS_GDM_WAYLAND=0
  for conf in /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
    if [ -f "${{conf}}" ] && ! grep -Eq '^[[:space:]]*WaylandEnable[[:space:]]*=[[:space:]]*false' "${{conf}}"; then
      {{ systemctl is-active --quiet gdm3 2>/dev/null || systemctl is-active --quiet gdm 2>/dev/null; }} && RS_GDM_WAYLAND=1
    fi
  done
  if [ "${{RS_GDM_WAYLAND}}" = "1" ] || ls /run/user/*/wayland-[0-9] >/dev/null 2>&1; then
    echo "Note: this desktop runs on Wayland. Remote Support needs X11 for unattended access." >&2
    echo "  Raspberry Pi OS: sudo raspi-config -> Advanced Options -> Wayland -> X11, then reboot." >&2
    echo "  GNOME (Ubuntu, Debian, Fedora, RHEL): set WaylandEnable=false under [daemon] in /etc/gdm3/custom.conf (or /etc/gdm/custom.conf), then reboot." >&2
  fi
}}

if [ "$(uname -m)" = "armv6l" ]; then
  echo "TECHI Remote Support: no build for ARMv6 - terminal only."
elif ! has_desktop; then
  echo "TECHI Remote Support: no desktop on this machine - terminal only."
elif [ -z "${{RS_PKG}}" ]; then
  echo "TECHI Remote Support: no RustDesk package for this distribution on ${{RS_ARCH}} - terminal only."
elif ! install_remote_support; then
  echo "TECHI Remote Support could not be installed; the agent is installed and works without it." >&2
fi
# The token is only passed when this host still has to enrol. Passing it
# otherwise would bake it into the systemd unit for no reason.
if [ "${{ENROLLED}}" = "1" ]; then
  echo "Already enrolled - installing service without an enrollment token."
  "${{BIN_PATH}}" install --config "${{CONFIG_PATH}}"
else
  echo "Installing systemd service and enrolling..."
  "${{BIN_PATH}}" install --config "${{CONFIG_PATH}}" --enrollment-token "${{TOKEN}}"
fi

echo "TECHI agent installed. Check status: systemctl status techi-agent"
[ -n "${{BACKUP}}" ] && echo "Previous binary kept at ${{BACKUP}}"

exit 0
"""
    return PlainTextResponse(content=script, media_type="text/x-shellscript")


# MikroTik connector protocol version — single source is the Platform
# Registry (`PLATFORM_REGISTRY["mikrotik"].latest_connector_version`), so
# script generation and the version badge (Drawer + Device List, see
# version_service.py) can never drift out of sync. Bump it there when the
# RouterOS enrollment template changes; this alias exists only for readability.
from app.platform_core.registry import PLATFORM_REGISTRY

MIKROTIK_CONNECTOR_VERSION = PLATFORM_REGISTRY["mikrotik"].latest_connector_version


@router.get("/mikrotik", response_class=PlainTextResponse)
def mikrotik_installer(
    token: str = Query(..., min_length=1),
    routeros_version: str = Query("7", pattern="^(6|7)$"),
) -> PlainTextResponse:
    """RouterOS enrollment/registration script, generated from the Platform
    Registry deployment template with the token + API endpoint injected. Gated by
    FEATURE_MIKROTIK (404 off). Registration only — no RouterOS management."""
    if not feature_enabled("FEATURE_MIKROTIK"):
        raise HTTPException(status_code=404, detail="Not Found")

    from app.platform_core.registry import render_deployment_script

    try:
        script = render_deployment_script(
            "mikrotik", token=token, api_endpoint=_public_base(),
            version=PLATFORM_REGISTRY["mikrotik"].latest_connector_version,
            routeros_version=routeros_version,
            heartbeat_interval_seconds=_agent_cfg.get_heartbeat_interval("mikrotik"),
            inventory_interval_seconds=_agent_cfg.get_inventory_interval("mikrotik"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return PlainTextResponse(content=script, media_type="text/plain")
