from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.trusted_domain import TrustedDomain
from app.repositories.client_repository import ClientRepository
from app.repositories.trusted_domain_repository import TrustedDomainRepository
from app.schemas.trusted_domain import TrustedDomainCreate, TrustedDomainUpdate


class TrustedDomainAdminService:
    def __init__(self, db: Session):
        self.db = db
        self.repository = TrustedDomainRepository(db)
        self.clients = ClientRepository(db)

    def list_domains(self) -> List[TrustedDomain]:
        return [self._attach_resolved_client_name(item) for item in self.repository.list()]

    def create_domain(self, payload: TrustedDomainCreate) -> TrustedDomain:
        self._validate_client(payload.client_id)
        if self.repository.get_by_domain(payload.domain):
            raise ValueError("Trusted domain already exists")
        return self._attach_resolved_client_name(self.repository.create(payload))

    def update_domain(self, domain_id: int, payload: TrustedDomainUpdate) -> Optional[TrustedDomain]:
        obj = self.repository.get(domain_id)
        if obj is None:
            return None
        self._validate_client(payload.client_id)
        if payload.domain and payload.domain != obj.domain:
            duplicate = self.repository.get_by_domain(payload.domain)
            if duplicate and duplicate.id != obj.id:
                raise ValueError("Trusted domain already exists")
        return self._attach_resolved_client_name(self.repository.update(obj, payload))

    def delete_domain(self, domain_id: int) -> Optional[TrustedDomain]:
        obj = self.repository.get(domain_id)
        if obj is None:
            return None
        return self.repository.delete(obj)

    def _validate_client(self, client_id: Optional[int]) -> None:
        if client_id is not None and self.clients.get(client_id) is None:
            raise ValueError("Client not found")

    @staticmethod
    def _attach_resolved_client_name(domain: TrustedDomain) -> TrustedDomain:
        setattr(domain, "resolved_client_name", domain.client.name if domain.client else domain.client_name)
        return domain
