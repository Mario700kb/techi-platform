from typing import List, Optional

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.operator import Operator, OperatorRole


class OperatorRepository:
    def __init__(self, db: Session):
        self.db = db

    def count(self) -> int:
        return self.db.query(Operator).count()

    def count_by_role(self, role: str) -> int:
        return self.db.query(Operator).filter(Operator.role == role).count()

    def count_active_owners(self) -> int:
        return (
            self.db.query(Operator)
            .filter(Operator.role == OperatorRole.OWNER.value, Operator.is_active.is_(True))
            .count()
        )

    def count_active_admins(self) -> int:
        return (
            self.db.query(Operator)
            .filter(
                Operator.role.in_((OperatorRole.OWNER.value, OperatorRole.ADMIN.value)),
                Operator.is_active.is_(True),
            )
            .count()
        )

    def list_all(self) -> List[Operator]:
        return self.db.query(Operator).order_by(Operator.created_at).all()

    def get(self, operator_id: int) -> Optional[Operator]:
        return self.db.query(Operator).filter(Operator.id == operator_id).first()

    def get_by_username(self, username: str) -> Optional[Operator]:
        return self.db.query(Operator).filter(Operator.username == username).first()

    def get_by_email(self, email: str) -> Optional[Operator]:
        return self.db.query(Operator).filter(Operator.email == email).first()

    def get_by_username_or_email(self, value: str) -> Optional[Operator]:
        return (
            self.db.query(Operator)
            .filter(or_(Operator.username == value, Operator.email == value))
            .first()
        )

    def create(
        self,
        *,
        username: str,
        email: str,
        display_name: Optional[str] = None,
        hashed_password: str,
        role: str,
        is_superuser: bool = False,
        is_active: bool = True,
    ) -> Operator:
        operator = Operator(
            username=username,
            email=email,
            display_name=display_name,
            hashed_password=hashed_password,
            role=role,
            is_superuser=is_superuser,
            is_active=is_active,
        )
        self.db.add(operator)
        try:
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise ValueError("Username or email already taken") from exc
        self.db.refresh(operator)
        return operator

    def save(self, operator: Operator) -> Operator:
        self.db.add(operator)
        self.db.commit()
        self.db.refresh(operator)
        return operator

    def delete(self, operator: Operator) -> Operator:
        self.db.delete(operator)
        self.db.commit()
        return operator
