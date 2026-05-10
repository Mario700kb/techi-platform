from datetime import datetime
from typing import Optional

from app.models.device import Device, DeviceStatus, DeviceType
from app.repositories.device_repository import DeviceRepository
from app.repositories.device_heartbeat_repository import DeviceHeartbeatRepository
from app.schemas.agent import AgentHeartbeatPayload, DeviceHeartbeatCreate
from app.schemas.device import DeviceCreate, DeviceUpdate


class DeviceHeartbeatService:
    def __init__(self, db):
        self.device_repo = DeviceRepository(db)
        self.heartbeat_repo = DeviceHeartbeatRepository(db)

    @staticmethod
    def classify_device_type(os_name: Optional[str], domain: Optional[str]) -> DeviceType:
        if not domain or domain.strip().upper() == "WORKGROUP":
            return DeviceType.UNASSIGNED

        if os_name:
            normalized = os_name.strip().lower()
            if "windows server" in normalized:
                return DeviceType.SERVER
            if "windows 10" in normalized or "windows 11" in normalized:
                return DeviceType.CLIENT

        return DeviceType.UNASSIGNED

    def process_heartbeat(self, payload: AgentHeartbeatPayload):
        device_type = self.classify_device_type(payload.os_name, payload.domain)
        now = datetime.utcnow()

        device = self.device_repo.get_by_rustdesk_id(payload.rustdesk_id)
        if device:
            update_data = payload.dict(exclude_unset=True, exclude={"rustdesk_id"})
            update_data["device_type"] = device_type
            update_data["status"] = DeviceStatus.ONLINE
            update_data["last_seen"] = now
            device = self.device_repo.update(device, DeviceUpdate(**update_data))
        else:
            create_data = payload.dict(exclude_unset=True)
            create_data["device_type"] = device_type
            create_data["status"] = DeviceStatus.ONLINE
            create_data["last_seen"] = now
            device = self.device_repo.create(DeviceCreate(**create_data))

        heartbeat_data = DeviceHeartbeatCreate(
            device_id=device.id,
            rustdesk_id=device.rustdesk_id,
            hostname=device.hostname,
            current_user=device.current_user,
            domain=device.domain,
            public_ip=device.public_ip,
            local_ip=device.local_ip,
            os_name=device.os_name,
            os_version=device.os_version,
            platform=device.platform,
            device_type=device.device_type,
            status=device.status,
            cpu=device.cpu,
            ram=device.ram,
            storage=device.storage,
        )
        heartbeat = self.heartbeat_repo.create(heartbeat_data)

        return device, heartbeat
