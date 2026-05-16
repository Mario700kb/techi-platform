from typing import List

from sqlalchemy.orm import Session

from app.core.auth import hash_password
from app.models.operator import Operator, OperatorRole
from app.repositories.operator_repository import OperatorRepository
from app.schemas.operator import OperatorCreate, OperatorPasswordReset, OperatorUpdate


class OperatorService:
    def __init__(self, db: Session):
        self.repo = OperatorRepository(db)

    def list_operators(self) -> List[Operator]:
        return self.repo.list_all()

    def get_operator(self, operator_id: int) -> Operator:
        op = self.repo.get(operator_id)
        if not op:
            raise ValueError("Operator not found")
        return op

    def create_operator(self, payload: OperatorCreate, caller: Operator) -> Operator:
        self._assert_can_manage_role(caller, payload.role.value, "create")

        if self.repo.get_by_username(payload.username):
            raise ValueError("Username already taken")
        if self.repo.get_by_email(str(payload.email)):
            raise ValueError("Email already taken")

        return self.repo.create(
            username=payload.username,
            email=str(payload.email),
            display_name=payload.display_name,
            hashed_password=hash_password(payload.password),
            role=payload.role.value,
        )

    def update_operator(self, operator_id: int, payload: OperatorUpdate, caller: Operator) -> Operator:
        target = self.repo.get(operator_id)
        if not target:
            raise ValueError("Operator not found")

        self._assert_can_manage_role(caller, target.role, "edit")

        if payload.role is not None and payload.role.value != target.role:
            self._assert_can_manage_role(caller, payload.role.value, "assign role")

        # Protect the last active owner from being locked out
        if payload.is_active is False and target.is_active:
            self._assert_not_last_active_owner(target, "deactivate")
        if payload.role is not None and payload.role.value != OperatorRole.OWNER.value and target.role == OperatorRole.OWNER.value:
            self._assert_not_last_active_owner(target, "change role of")

        if payload.username is not None:
            existing = self.repo.get_by_username(payload.username)
            if existing and existing.id != operator_id:
                raise ValueError("Username already taken")
            target.username = payload.username

        if payload.email is not None:
            existing = self.repo.get_by_email(str(payload.email))
            if existing and existing.id != operator_id:
                raise ValueError("Email already taken")
            target.email = str(payload.email)

        if payload.display_name is not None:
            target.display_name = payload.display_name

        if payload.role is not None:
            target.role = payload.role.value

        if payload.is_active is not None:
            target.is_active = payload.is_active

        return self.repo.save(target)

    def delete_operator(self, operator_id: int, caller: Operator) -> Operator:
        target = self.repo.get(operator_id)
        if not target:
            raise ValueError("Operator not found")

        if target.id == caller.id:
            raise ValueError("Cannot delete your own account")

        self._assert_can_manage_role(caller, target.role, "delete")

        if target.role == OperatorRole.OWNER.value:
            if self.repo.count_by_role(OperatorRole.OWNER.value) <= 1:
                raise ValueError("Cannot delete the last owner account")

        return self.repo.delete(target)

    def reset_password(self, operator_id: int, payload: OperatorPasswordReset, caller: Operator) -> Operator:
        target = self.repo.get(operator_id)
        if not target:
            raise ValueError("Operator not found")

        if target.id != caller.id:
            self._assert_can_manage_role(caller, target.role, "reset password for")

        if not payload.new_password or len(payload.new_password) < 8:
            raise ValueError("Password must be at least 8 characters")

        target.hashed_password = hash_password(payload.new_password)
        return self.repo.save(target)

    def _assert_not_last_active_owner(self, target: Operator, action: str) -> None:
        if target.role == OperatorRole.OWNER.value and target.is_active:
            if self.repo.count_active_owners() <= 1:
                raise ValueError(f"Cannot {action} the last active owner account")

    def _assert_can_manage_role(self, caller: Operator, target_role: str, action: str) -> None:
        """
        owner  → can manage all roles
        admin  → can manage operator/readonly only
        others → cannot manage operators at all
        """
        if caller.role == OperatorRole.OWNER.value:
            return
        if caller.role == OperatorRole.ADMIN.value:
            if target_role in (OperatorRole.OWNER.value, OperatorRole.ADMIN.value):
                raise PermissionError(f"Admins cannot {action} owner or admin accounts")
            return
        raise PermissionError("Insufficient role to manage operators")
