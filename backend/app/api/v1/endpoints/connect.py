"""Connect Framework API (Platform Expansion Phase 7).

`GET /devices/{id}/connect-methods` returns the connection methods available
for a device, generated from the Connect metadata + the device's reported
capabilities. The frontend Connect dropdown is built entirely from this — no
hardcoded per-platform dropdowns.

`GET /devices/{id}/connect-methods/{method_id}/launch` returns the launch URL
for a method (desktop scheme or browser URL built from the device's IP) —
generic for every platform via `ConnectMethod.scheme`/`web_path`, no
per-platform launcher code. Permission and audit reuse the same
`remote_support_connect` permission and `remote_connect` audit action as the
existing Windows Remote Support connect flow.

Gated by FEATURE_PLATFORM_CORE (404 when off) so today's production, where the
existing Windows Connect button is untouched, is unchanged.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_team_permission
from app.db.session import get_db
from app.models.operator import Operator
from app.platform_core.actions import actions_for, effective_capabilities
from app.platform_core.capabilities import capability_tabs
from app.platform_core.connect import methods_for
from app.platform_core.flags import feature_enabled
from app.platform_core.registry import resolve_platform
from app.repositories.device_repository import DeviceRepository
from app.services import version_service
from app.services.audit_service import AuditAction, audit_log
from app.services.permission_service import REMOTE_SUPPORT_CONNECT

router = APIRouter()


class ConnectMethodOut(BaseModel):
    id: str
    label: str
    surface: str            # desktop | browser
    capability: Optional[str] = None
    priority: int
    scheme: Optional[str] = None
    # Operator client OS this method's desktop app requires (e.g. "windows"
    # for Winbox), or None if it works on any OS. The frontend hides methods
    # that don't match the operator's detected OS.
    requires_client_os: Optional[str] = None


class ConnectMethodsResponse(BaseModel):
    platform: str
    methods: List[ConnectMethodOut]


@router.get("/devices/{device_id}/connect-methods", response_model=ConnectMethodsResponse)
def device_connect_methods(
    device_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
):
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    methods = methods_for(platform_id, device.capabilities)
    return ConnectMethodsResponse(
        platform=platform_id,
        methods=[
            ConnectMethodOut(
                id=m.id, label=m.label, surface=m.surface,
                capability=m.capability, priority=m.priority, scheme=m.scheme,
                requires_client_os=m.requires_client_os,
            )
            for m in methods
        ],
    )


class ConnectLaunchResponse(BaseModel):
    url: str
    surface: str  # desktop | browser — tells the frontend how to open `url`


# Methods with their own dedicated, already-audited flow — not launched here.
_DEDICATED_METHOD_IDS = frozenset({"remote_support", "web_terminal"})


@router.get("/devices/{device_id}/connect-methods/{method_id}/launch", response_model=ConnectLaunchResponse)
def device_connect_launch(
    device_id: int,
    method_id: str,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    _perm: None = Depends(require_team_permission(REMOTE_SUPPORT_CONNECT)),
):
    """Build the launch URL for a Connect method — generic for every platform:
    `scheme://<host>` for desktop methods (Winbox, SSH…), `http://<host><web_path>`
    for browser methods (WebFig…). `remote_support`/`web_terminal` keep their own
    dedicated endpoints and are rejected here."""
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    available = {m.id: m for m in methods_for(platform_id, device.capabilities)}
    method = available.get(method_id)
    if method is None:
        raise HTTPException(status_code=404, detail="Connect method not available for this device")
    if method.id in _DEDICATED_METHOD_IDS:
        raise HTTPException(status_code=400, detail=f"'{method.id}' uses its own connect flow, not the generic launcher")

    host = device.local_ip or device.public_ip
    if not host:
        raise HTTPException(status_code=409, detail="Device has no known IP address yet")

    url = f"{method.scheme}{host}" if method.scheme else f"http://{host}{method.web_path or '/'}"

    audit_log(
        db,
        operator=operator,
        action=AuditAction.REMOTE_CONNECT,
        entity_type="device",
        entity_id=device_id,
        details={"method": method.id, "platform": platform_id, "surface": method.surface},
    )

    return ConnectLaunchResponse(url=url, surface=method.surface)


class DrawerActionOut(BaseModel):
    id: str
    label: str
    permission: Optional[str] = None
    required_capability: Optional[str] = None
    confirm: str
    target: str


class DrawerMetaResponse(BaseModel):
    """The single feed the registry-driven Device Drawer renders from: the
    device's effective capabilities, its Connect methods, its available Actions
    and its capability-driven tabs — all derived from the Platform / Capability /
    Connect / Action registries. Windows (no reported capabilities) resolves to
    its declared surface, so its Drawer is unchanged."""
    platform: str
    capabilities: List[str]
    remote_support: bool          # show the Remote Support tab
    terminal: bool                # show the Terminal tab
    capability_tabs: List[str]    # dynamic tabs (services/docker/logs/…)
    connect_methods: List[ConnectMethodOut]
    actions: List[DrawerActionOut]
    # Version Service (reused, not reimplemented per platform): the device's
    # reported connector/agent version, the platform's latest, and the
    # current/outdated/ahead status the badge renders from. None for Windows
    # (its classic Drawer has its own separate, untouched badge mechanism).
    reported_version: Optional[str] = None
    latest_version: Optional[str] = None
    version_status: Optional[str] = None


@router.get("/devices/{device_id}/drawer", response_model=DrawerMetaResponse)
def device_drawer_meta(
    device_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
):
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    eff = effective_capabilities(device.platform, device.capabilities)
    methods = methods_for(platform_id, device.capabilities)
    actions = actions_for(device.platform, device.capabilities)

    latest_version = version_service.get_active_version(platform_id) if platform_id != "windows" else None
    version_status = version_service.compare_versions(device.agent_version, latest_version) if latest_version else None

    return DrawerMetaResponse(
        platform=platform_id,
        capabilities=sorted(eff),
        remote_support="remote_support" in eff,
        terminal="terminal" in eff,
        capability_tabs=capability_tabs(eff),
        connect_methods=[
            ConnectMethodOut(id=m.id, label=m.label, surface=m.surface,
                             capability=m.capability, priority=m.priority, scheme=m.scheme,
                             requires_client_os=m.requires_client_os)
            for m in methods
        ],
        actions=[
            DrawerActionOut(id=a.id, label=a.label, permission=a.permission,
                            required_capability=a.required_capability,
                            confirm=a.confirm, target=a.target)
            for a in actions
        ],
        reported_version=device.agent_version,
        latest_version=latest_version,
        version_status=version_status,
    )
