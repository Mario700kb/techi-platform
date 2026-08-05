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


@router.get("/linux", response_class=PlainTextResponse)
def linux_installer(token: str = Query(..., min_length=1)) -> PlainTextResponse:
    if not feature_enabled("FEATURE_LINUX"):
        raise HTTPException(status_code=404, detail="Not Found")

    base = _public_base()
    ws = _ws_base(base)
    checksums = _linux_checksums()
    heartbeat = _agent_cfg.get_heartbeat_interval("linux")
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

case "${{ARCH}}" in
{checksums}
esac

TMP_BIN="$(mktemp /tmp/techi-agent-XXXXXX)"
BACKUP=""
cleanup() {{ rm -f "${{TMP_BIN}}"; }}
trap cleanup EXIT

# Download BEFORE stopping anything, so a failed download costs no downtime.
echo "Downloading TECHI agent (linux-${{ARCH}})..."
curl -fsSL "${{BACKEND}}/api/v1/agent-packages/platform/linux-${{ARCH}}/download" -o "${{TMP_BIN}}"

if [ -n "${{EXPECTED_SHA256}}" ] && command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "${{TMP_BIN}}" | awk '{{print $1}}')"
  if [ "${{ACTUAL_SHA256}}" != "${{EXPECTED_SHA256}}" ]; then
    echo "Checksum mismatch - refusing to install." >&2
    echo "  expected: ${{EXPECTED_SHA256}}" >&2
    echo "  actual:   ${{ACTUAL_SHA256}}" >&2
    exit 1
  fi
  echo "Checksum verified."
else
  echo "Checksum not verified (no published checksum or sha256sum unavailable)."
fi

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
  if grep -q '"agent_id"[[:space:]]*:[[:space:]]*"[^"]\\+"' "${{CONFIG_PATH}}"; then
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
