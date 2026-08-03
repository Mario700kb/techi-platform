"""
Agent configuration policy endpoints.

GET  /api/v1/agent-config                        — read current platform policy
PUT  /api/v1/agent-config                        — update heartbeat/inventory policy
GET  /api/v1/agent-config/heartbeat-script       — download PowerShell rollout script

All three endpoints require admin or owner role.

NOTE: The current TechiAgent MSI binary does NOT support an apply_agent_config
remote action. Propagating interval changes to endpoints requires distributing
the generated PowerShell script via GPO or running it manually per device.
"""

import logging
from datetime import datetime, timezone
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.repositories.device_repository import DeviceRepository
from app.services import agent_config_service as _svc

logger = logging.getLogger(__name__)

router = APIRouter()

_require_admin = require_min_role(OperatorRole.ADMIN.value)


class AgentConfigResponse(BaseModel):
    heartbeat_interval_seconds: int
    platform_heartbeat_intervals: Dict[str, int]
    platform_inventory_intervals: Dict[str, int]
    online_threshold_minutes: int
    stale_threshold_minutes: int
    remote_support_managed_password_enabled: bool
    # Capacity context: what the current fleet costs at the current interval,
    # and the lowest interval this deployment will accept. Surfaced so the
    # consequence of lowering the interval is visible before saving, not after.
    active_device_count: int = 0
    projected_requests_per_second: float = 0.0
    minimum_allowed_interval_seconds: int = _svc.HEARTBEAT_INTERVAL_MIN


class AgentConfigUpdate(BaseModel):
    heartbeat_interval_seconds: Optional[int] = Field(
        None,
        ge=_svc.HEARTBEAT_INTERVAL_MIN,
        le=_svc.HEARTBEAT_INTERVAL_MAX,
        description=f"Seconds between agent heartbeats ({_svc.HEARTBEAT_INTERVAL_MIN}–{_svc.HEARTBEAT_INTERVAL_MAX})",
    )
    platform_heartbeat_intervals: Optional[Dict[str, int]] = Field(
        None,
        description="Per-platform heartbeat intervals in seconds",
    )
    platform_inventory_intervals: Optional[Dict[str, int]] = Field(
        None,
        description="Per-platform inventory intervals in seconds",
    )
    remote_support_managed_password_enabled: Optional[bool] = None


def _active_device_count(db: Session) -> int:
    """Fleet size the interval has to serve. Never fails the request: a
    capacity floor is a guardrail, and a guardrail that 500s is worse than one
    that degrades to the static minimum."""
    try:
        return DeviceRepository(db).count()
    except Exception:
        logger.exception("agent-config: could not count devices; falling back to the static floor")
        return 0


def _with_capacity_context(policy: dict, device_count: int) -> dict:
    enriched = dict(policy)
    enriched["active_device_count"] = device_count
    enriched["projected_requests_per_second"] = _svc.projected_requests_per_second(
        device_count, policy.get("heartbeat_interval_seconds", 0)
    )
    enriched["minimum_allowed_interval_seconds"] = _svc.capacity_floor_seconds(device_count)
    return enriched


def _reject_below_capacity_floor(requested: Dict[str, int], device_count: int) -> None:
    """Raise 422 if any requested heartbeat interval would exceed the rate budget."""
    floor = _svc.capacity_floor_seconds(device_count)
    for platform, seconds in requested.items():
        if seconds is None or seconds >= floor:
            continue
        rate = _svc.projected_requests_per_second(device_count, seconds)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"heartbeat interval {seconds}s for '{platform}' is below the capacity floor "
                f"of {floor}s for {device_count} devices: it projects {rate} requests/s against "
                f"a budget of {_svc.HEARTBEAT_RATE_BUDGET_PER_SEC} req/s. "
                f"Raise HEARTBEAT_RATE_BUDGET_PER_SEC only together with host capacity."
            ),
        )


@router.get("", response_model=AgentConfigResponse)
def get_agent_config(
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_admin),
):
    return _with_capacity_context(_svc.get_policy(), _active_device_count(db))


@router.put("", response_model=AgentConfigResponse)
def put_agent_config(
    body: AgentConfigUpdate,
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_admin),
):
    device_count = _active_device_count(db)

    requested: Dict[str, int] = {}
    if body.heartbeat_interval_seconds is not None:
        requested["windows"] = body.heartbeat_interval_seconds
    if body.platform_heartbeat_intervals:
        requested.update(body.platform_heartbeat_intervals)
    _reject_below_capacity_floor(requested, device_count)

    try:
        policy = _svc.set_policy(
            heartbeat_interval_seconds=body.heartbeat_interval_seconds,
            platform_heartbeat_intervals=body.platform_heartbeat_intervals,
            platform_inventory_intervals=body.platform_inventory_intervals,
            remote_support_managed_password_enabled=body.remote_support_managed_password_enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return _with_capacity_context(policy, device_count)


@router.get("/heartbeat-script", response_class=PlainTextResponse)
def get_heartbeat_script(
    seconds: int = Query(
        ...,
        ge=_svc.HEARTBEAT_INTERVAL_MIN,
        le=_svc.HEARTBEAT_INTERVAL_MAX,
        description="Target heartbeat_interval_seconds to write into the agent config",
    ),
    _: Operator = Depends(_require_admin),
):
    """
    Returns a PowerShell script suitable for direct execution or GPO deployment.

    The script:
    1. Reads C:\\ProgramData\\TECHI\\agent.config.json
       (migrates C:\\ProgramData\\TechiAgent\\agent.config.json if needed)
    2. Updates heartbeat_interval_seconds (all other keys preserved)
    3. Restarts the TechiAgent Windows service
    4. Logs each step to C:\\Windows\\Temp\\techi-heartbeat-config.log

    No MSI rebuild is required. Agent re-reads the config at each startup.
    """
    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    return PlainTextResponse(
        content=_build_ps_script(seconds, ts),
        media_type="text/plain; charset=utf-8",
    )


# ── PowerShell script builder ─────────────────────────────────────────────── #

def _build_ps_script(seconds: int, generated_at: str) -> str:
    # Double braces {{ }} in f-strings produce literal { } in the output,
    # which is what PowerShell expects for script blocks and hashtables.
    return f"""\
# ============================================================
# TECHI Agent Heartbeat Configuration Script
# Generated  : {generated_at}
# Platform   : TECHI Platform
# Target     : heartbeat_interval_seconds = {seconds}
# ============================================================
#
# DISTRIBUTION: Run directly (as Administrator) or deploy via GPO:
#   Computer Configuration > Preferences > Windows Settings > Files
#   + Scheduled Task (System context, Run as Administrator)
#
# NOTE: The current TechiAgent binary does NOT support apply_agent_config
# as a remote action. This script is the recommended propagation method.
# ============================================================

#Requires -RunAsAdministrator

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ConfigPath = "C:\\ProgramData\\TECHI\\agent.config.json"
$LegacyConfigPath = "C:\\ProgramData\\TechiAgent\\agent.config.json"
$LogPath    = "C:\\Windows\\Temp\\techi-heartbeat-config.log"
$TargetSec  = {seconds}

function Write-Log {{
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$ts  $Message"
    $line | Out-File -FilePath $LogPath -Append -Encoding UTF8
    Write-Host $line
}}

Write-Log "==================================================="
Write-Log "TECHI heartbeat config update: target=$TargetSec s"
Write-Log "==================================================="

# ── 1. Verify config file exists ────────────────────────────
if (-not (Test-Path $ConfigPath)) {{
    if (Test-Path $LegacyConfigPath) {{
        try {{
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
            Copy-Item -LiteralPath $LegacyConfigPath -Destination $ConfigPath -Force
            Write-Log "Migrated legacy config to $ConfigPath"
        }} catch {{
            Write-Log "ERROR migrating legacy config: $_"
            exit 1
        }}
    }} else {{
        Write-Log "ERROR: $ConfigPath not found. Is TechiAgent installed?"
        exit 1
    }}
}}

# ── 2. Read, update, write ───────────────────────────────────
try {{
    $raw    = Get-Content -Path $ConfigPath -Raw -Encoding UTF8
    $cfg    = $raw | ConvertFrom-Json
    $oldVal = $cfg.heartbeat_interval_seconds
    $cfg.heartbeat_interval_seconds = $TargetSec
    # ConvertTo-Json preserves all existing keys; -Depth 10 keeps nested objects intact
    $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Encoding UTF8
    Write-Log "heartbeat_interval_seconds updated: $oldVal -> $TargetSec"
}} catch {{
    Write-Log "ERROR updating config: $_"
    exit 1
}}

# ── 3. Restart service ───────────────────────────────────────
Write-Log "Restarting TechiAgent service..."
try {{
    Stop-Service  -Name "TechiAgent" -Force -ErrorAction Stop
    Start-Sleep   -Seconds 2
    Start-Service -Name "TechiAgent" -ErrorAction Stop
    Start-Sleep   -Seconds 3
    $svcStatus = (Get-Service -Name "TechiAgent").Status
    Write-Log "TechiAgent status after restart: $svcStatus"
    if ($svcStatus -ne "Running") {{
        Write-Log "WARNING: Service did not reach Running state. Check Windows Event Log."
    }}
}} catch {{
    Write-Log "ERROR restarting TechiAgent: $_"
    exit 1
}}

Write-Log "Done. heartbeat_interval_seconds is now $TargetSec seconds."
Write-Log "Log: $LogPath"
"""
