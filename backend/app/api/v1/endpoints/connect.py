"""Connect Framework API (Platform Expansion Phase 7).

`GET /devices/{id}/connect-methods` returns the connection methods available
for a device, generated from the Connect metadata + the device's reported
capabilities. The frontend Connect dropdown is built entirely from this — no
hardcoded per-platform dropdowns.

Gated by FEATURE_PLATFORM_CORE (404 when off) so today's production, where the
existing Windows Connect button is untouched, is unchanged. Read-only; launchers
are a later phase (this returns metadata only).
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator
from app.db.session import get_db
from app.models.operator import Operator
from app.platform_core.connect import methods_for
from app.platform_core.flags import feature_enabled
from app.platform_core.registry import resolve_platform
from app.repositories.device_repository import DeviceRepository

router = APIRouter()


class ConnectMethodOut(BaseModel):
    id: str
    label: str
    surface: str            # desktop | browser
    capability: Optional[str] = None
    priority: int
    scheme: Optional[str] = None


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
            )
            for m in methods
        ],
    )
