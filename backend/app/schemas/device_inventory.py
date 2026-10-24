from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel

from app.schemas.security_posture import SecurityPosture


class ProcessSnapshot(BaseModel):
    pid: int
    name: str
    memory_mb: Optional[float] = None


class ServiceSnapshot(BaseModel):
    name: str
    display_name: str
    status: str
    startup_type: Optional[str] = None


class SoftwareSnapshot(BaseModel):
    name: str
    version: Optional[str] = None
    publisher: Optional[str] = None
    install_date: Optional[str] = None
    # Windows agents from 2.1.41: how the app can be removed with nobody at
    # the PC ("msi" or "quiet"), and the registry entry the agent reads again.
    uninstall: Optional[str] = None
    uninstall_key: Optional[str] = None


class PatchStatusSnapshot(BaseModel):
    device_id: Optional[int] = None
    pending_updates: Optional[int] = None
    reboot_required: bool = False
    last_update_at: Optional[str] = None
    patch_state: str = "unknown"


class DeviceInventoryResponse(BaseModel):
    device_id: int
    processes: List[ProcessSnapshot] = []
    services: List[ServiceSnapshot] = []
    software: List[SoftwareSnapshot] = []
    pending_updates: Optional[int] = None
    reboot_required: bool = False
    last_update_at: Optional[str] = None
    patch_state: str = "unknown"
    collected_at: Optional[datetime] = None
    # Windows agents >= 2.1.31; None until the first report.
    security_posture: Optional[SecurityPosture] = None
    security_collected_at: Optional[datetime] = None
