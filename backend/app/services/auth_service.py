import logging
import secrets
from datetime import datetime
from app.core.time import utcnow
from typing import Optional

from sqlalchemy.orm import Session

from app.core.auth import hash_password, verify_password
from app.core.config import settings
from app.models.operator import Operator, OperatorRole
from app.repositories.operator_repository import OperatorRepository

logger = logging.getLogger(__name__)


class AuthService:
    def __init__(self, db: Session):
        self.repo = OperatorRepository(db)

    def authenticate(self, username: str, password: str) -> Optional[Operator]:
        operator = self.repo.get_by_username_or_email(username)
        if not operator or not operator.is_active:
            return None
        if not verify_password(password, operator.hashed_password):
            return None
        operator.last_login_at = utcnow()
        self.repo.save(operator)
        return operator


def ensure_bootstrap_owner(db: Session) -> None:
    repo = OperatorRepository(db)
    if repo.count_active_owners() > 0:
        return

    password = settings.BOOTSTRAP_OWNER_PASSWORD or secrets.token_urlsafe(18)
    repo.create(
        username=settings.BOOTSTRAP_OWNER_USERNAME,
        email=settings.BOOTSTRAP_OWNER_EMAIL,
        hashed_password=hash_password(password),
        role=OperatorRole.OWNER.value,
        is_superuser=True,
    )
    if settings.BOOTSTRAP_OWNER_PASSWORD:
        logger.warning("Bootstrap owner created from environment user=%s", settings.BOOTSTRAP_OWNER_USERNAME)
    else:
        logger.warning("Bootstrap owner created user=%s temporary_password=%s", settings.BOOTSTRAP_OWNER_USERNAME, password)
