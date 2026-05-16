import re
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.client import Client
from app.repositories.client_repository import ClientRepository
from app.repositories.device_group_repository import DeviceGroupRepository
from app.repositories.device_repository import DeviceRepository
from app.schemas.client import ClientCreate, ClientUpdate


class ClientService:
    def __init__(self, db: Session):
        self.repository = ClientRepository(db)
        self.devices = DeviceRepository(db)
        self.groups = DeviceGroupRepository(db)

    def list_clients(self) -> List[Client]:
        return self.repository.list()

    def get_client(self, client_id: int) -> Optional[Client]:
        return self.repository.get(client_id)

    def create_client(self, payload: ClientCreate) -> Client:
        slug = self._normalize_slug(payload.slug or payload.name)
        if self.repository.get_duplicate_name(payload.name):
            raise ValueError("Client name already exists")
        if self.repository.get_by_slug(slug):
            raise ValueError("Client slug already exists")
        return self.repository.create(payload, slug=slug)

    def update_client(self, client_id: int, payload: ClientUpdate) -> Optional[Client]:
        client = self.repository.get(client_id)
        if not client:
            return None
        if payload.name and self.repository.get_duplicate_name(payload.name, exclude_client_id=client.id):
            raise ValueError("Client name already exists")
        return self.repository.update(client, payload)

    def delete_client(self, client_id: int) -> Optional[Client]:
        client = self.repository.get(client_id)
        if not client:
            return None
        self.devices.clear_client(client_id)
        self.groups.delete_by_client(client_id)
        return self.repository.delete(client)

    @staticmethod
    def _normalize_slug(value: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
        if not slug:
            raise ValueError("Client slug is required")
        return slug[:140]
