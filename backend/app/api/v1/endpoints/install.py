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


@router.get("/linux", response_class=PlainTextResponse)
def linux_installer(token: str = Query(..., min_length=1)) -> PlainTextResponse:
    if not feature_enabled("FEATURE_LINUX"):
        raise HTTPException(status_code=404, detail="Not Found")

    base = _public_base()
    ws = _ws_base(base)
    # The token is echoed into the script the operator generated; it is not a
    # secret to the backend. Keep it out of logs by not logging the query.
    script = f"""#!/usr/bin/env bash
set -euo pipefail

# TECHI Linux Agent installer (Platform Expansion Phase 2)
BACKEND="{base}"
TOKEN="{token}"
BIN_PATH="/usr/local/bin/techi-agent"
CONFIG_DIR="/etc/techi-agent"
CONFIG_PATH="${{CONFIG_DIR}}/agent.config.json"

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

echo "Downloading TECHI agent (linux-${{ARCH}})..."
curl -fsSL "${{BACKEND}}/api/v1/agent-packages/platform/linux-${{ARCH}}/download" -o "${{BIN_PATH}}"
chmod +x "${{BIN_PATH}}"

mkdir -p "${{CONFIG_DIR}}"
cat > "${{CONFIG_PATH}}" <<JSON
{{
  "backend_url": "${{BACKEND}}/api/v1/agent/heartbeat",
  "api_url": "${{BACKEND}}",
  "websocket_url": "{ws}/ws/devices",
  "public_ip_service": "https://api.ipify.org",
  "timeout_seconds": 30,
  "heartbeat_interval_seconds": 60,
  "retries": 3,
  "retry_delay_seconds": 5
}}
JSON
chmod 600 "${{CONFIG_PATH}}"

echo "Installing systemd service and enrolling..."
"${{BIN_PATH}}" install --config "${{CONFIG_PATH}}" --enrollment-token "${{TOKEN}}"

echo "TECHI agent installed. Check status: systemctl status techi-agent"
"""
    return PlainTextResponse(content=script, media_type="text/x-shellscript")


# MikroTik connector protocol version (deployment + registration only; no
# on-device agent). Bumped when the RouterOS enrollment template changes.
MIKROTIK_CONNECTOR_VERSION = "1.0.0"


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
            version=MIKROTIK_CONNECTOR_VERSION,
            routeros_version=routeros_version,
            heartbeat_interval_seconds=_agent_cfg.get_heartbeat_interval("mikrotik"),
            inventory_interval_seconds=_agent_cfg.get_inventory_interval("mikrotik"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return PlainTextResponse(content=script, media_type="text/plain")
