from typing import List, Optional

from sqlalchemy.orm import Session
from sqlalchemy import func

from app.models.client import Client
from app.schemas.client import ClientCreate, ClientUpdate


class ClientRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, client_id: int) -> Optional[Client]:
        return self.db.query(Client).filter(Client.id == client_id).first()

    def get_by_slug(self, slug: str) -> Optional[Client]:
        return self.db.query(Client).filter(Client.slug == slug).first()

    def get_by_name_normalized(self, name: str) -> Optional[Client]:
        normalized = name.strip().lower()
        return self.db.query(Client).filter(func.lower(func.trim(Client.name)) == normalized).first()

    def get_duplicate_name(self, name: str, *, exclude_client_id: Optional[int] = None) -> Optional[Client]:
        query = self.db.query(Client).filter(func.lower(func.trim(Client.name)) == name.strip().lower())
        if exclude_client_id is not None:
            query = query.filter(Client.id != exclude_client_id)
        return query.first()

    def list(self, *, include_inactive: bool = False) -> List[Client]:
        query = self.db.query(Client)
        if not include_inactive:
            query = query.filter(Client.is_active.is_(True))
        return query.order_by(Client.name.asc()).all()

    def create(self, payload: ClientCreate, *, slug: str) -> Client:
        client = Client(
            name=payload.name.strip(),
            slug=slug,
            description=payload.description,
            is_active=payload.is_active,
        )
        self.db.add(client)
        self.db.commit()
        self.db.refresh(client)
        return client

    def update(self, client: Client, payload: ClientUpdate) -> Client:
        update_data = payload.model_dump(exclude_unset=True)
        if "name" in update_data and update_data["name"] is not None:
            update_data["name"] = update_data["name"].strip()
        for field, value in update_data.items():
            setattr(client, field, value)
        self.db.add(client)
        self.db.commit()
        self.db.refresh(client)
        return client

    def delete(self, client: Client) -> Client:
        self.db.delete(client)
        self.db.commit()
        return client
