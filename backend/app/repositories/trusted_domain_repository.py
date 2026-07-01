from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.trusted_domain import TrustedDomain
from app.schemas.trusted_domain import TrustedDomainCreate, TrustedDomainUpdate


class TrustedDomainRepository:
    def __init__(self, db: Session):
        self.db = db

    def list(self, *, include_inactive: bool = True) -> List[TrustedDomain]:
        query = self.db.query(TrustedDomain)
        if not include_inactive:
            query = query.filter(TrustedDomain.is_active.is_(True))
        return query.order_by(TrustedDomain.domain.asc()).all()

    def get(self, domain_id: int) -> Optional[TrustedDomain]:
        return self.db.query(TrustedDomain).filter(TrustedDomain.id == domain_id).first()

    def get_by_domain(self, domain: str) -> Optional[TrustedDomain]:
        normalized = domain.strip().lower().rstrip(".")
        return self.db.query(TrustedDomain).filter(TrustedDomain.domain == normalized).first()

    def create(self, payload: TrustedDomainCreate) -> TrustedDomain:
        obj = TrustedDomain(**payload.model_dump())
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, obj: TrustedDomain, payload: TrustedDomainUpdate) -> TrustedDomain:
        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(obj, field, value)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, obj: TrustedDomain) -> TrustedDomain:
        self.db.delete(obj)
        self.db.commit()
        return obj
