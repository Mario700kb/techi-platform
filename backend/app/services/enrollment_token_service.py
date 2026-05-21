import hashlib
import logging
import secrets
from datetime import timedelta
from app.core.time import ensure_utc, utcnow
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus
from app.repositories.enrollment_token_repository import EnrollmentTokenRepository
from app.schemas.enrollment_token import (
    EnrollmentTokenCreate,
    EnrollmentTokenCreateResponse,
    EnrollmentTokenOut,
    EnrollmentTokenVerifyResponse,
)

logger = logging.getLogger(__name__)


class EnrollmentTokenService:
    def __init__(self, db: Session):
        self.repo = EnrollmentTokenRepository(db)

    @staticmethod
    def generate_plaintext_token() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()

    def create(
        self,
        payload: EnrollmentTokenCreate,
        *,
        _is_default: bool = False,
    ) -> EnrollmentTokenCreateResponse:
        plaintext_token, token_hash = self._generate_unique_token()
        token = EnrollmentToken(
            name=payload.name.strip(),
            token_hash=token_hash,
            token_prefix=plaintext_token[:8],
            status=EnrollmentTokenStatus.ACTIVE,
            expires_at=payload.expires_at,
            max_uses=payload.max_uses,
            use_count=0,
            client_id=payload.client_id,
            group_id=payload.group_id,
            is_default=_is_default,
        )
        created = self.repo.create(token)
        data = EnrollmentTokenOut.model_validate(created).model_dump()
        return EnrollmentTokenCreateResponse(**data, token=plaintext_token)

    def get_default_token(self) -> Optional[EnrollmentToken]:
        return self.repo.get_active_default()

    def ensure_default_token(self, *, enabled: bool, max_uses: int, expires_days: int) -> None:
        if not enabled:
            return
        existing = self.repo.get_active_default()
        if existing:
            logger.info("Default deployment token already exists (id=%d)", existing.id)
            return
        expires_at = utcnow() + timedelta(days=expires_days) if expires_days > 0 else None
        payload = EnrollmentTokenCreate(name="Default Deployment", max_uses=max_uses, expires_at=expires_at)
        result = self.create(payload, _is_default=True)
        logger.info("Created default deployment token (id=%d prefix=%s)", result.id, result.token_prefix)

    def regenerate_default(self) -> EnrollmentTokenCreateResponse:
        old = self.repo.get_any_default()
        if old and old.status == EnrollmentTokenStatus.ACTIVE:
            old.status = EnrollmentTokenStatus.REVOKED
            self.repo.save(old)
            logger.info("Revoked old default deployment token (id=%d)", old.id)

        from app.core.config import settings
        expires_days = settings.DEFAULT_DEPLOYMENT_TOKEN_EXPIRES_DAYS
        max_uses = settings.DEFAULT_DEPLOYMENT_TOKEN_MAX_USES
        expires_at = utcnow() + timedelta(days=expires_days) if expires_days > 0 else None
        payload = EnrollmentTokenCreate(name="Default Deployment", max_uses=max_uses, expires_at=expires_at)
        result = self.create(payload, _is_default=True)
        logger.info("Regenerated default deployment token (id=%d prefix=%s)", result.id, result.token_prefix)
        return result

    def ensure_internal_bootstrap_token(self, *, kind: str, expires_hours: int) -> EnrollmentToken:
        """Create/reuse a hidden token for tokenless bootstrap auditability.

        The plaintext value is intentionally not returned or embedded in scripts.
        Trusted-domain enrollment is validated by domain at /agent/enroll.
        """
        normalized_kind = kind.strip().lower()[:32] or "bootstrap"
        existing = self.repo.get_active_internal(normalized_kind)
        if existing:
            refreshed = self._refresh_status(existing)
            if refreshed.status == EnrollmentTokenStatus.ACTIVE:
                return refreshed

        plaintext_token, token_hash = self._generate_unique_token()
        expires_at = utcnow() + timedelta(hours=max(1, expires_hours))
        token = EnrollmentToken(
            name=f"Internal {normalized_kind} bootstrap",
            token_hash=token_hash,
            token_prefix=plaintext_token[:8],
            status=EnrollmentTokenStatus.ACTIVE,
            expires_at=expires_at,
            max_uses=1000000,
            use_count=0,
            client_id=None,
            group_id=None,
            is_default=False,
            is_internal=True,
            internal_kind=normalized_kind,
        )
        created = self.repo.create(token)
        logger.info("Created internal bootstrap identity kind=%s id=%d prefix=%s", normalized_kind, created.id, created.token_prefix)
        return created

    def list(self, *, limit: int = 100, offset: int = 0) -> List[EnrollmentToken]:
        tokens = self.repo.list(limit=limit, offset=offset)
        for token in tokens:
            self._refresh_status(token)
        return tokens

    def revoke(self, token_id: int) -> EnrollmentToken:
        token = self.repo.get(token_id)
        if not token:
            raise ValueError("Enrollment token not found")
        if token.status != EnrollmentTokenStatus.REVOKED:
            token.status = EnrollmentTokenStatus.REVOKED
            token = self.repo.save(token)
        return token

    def delete(
        self,
        token_id: int,
        *,
        confirm_active: bool = False,
        confirm_default: bool = False,
    ) -> EnrollmentToken:
        token = self.repo.get(token_id)
        if not token:
            raise ValueError("Enrollment token not found")
        self._refresh_status(token)
        if token.status == EnrollmentTokenStatus.ACTIVE and not confirm_active:
            raise ValueError("Active enrollment tokens require confirmation before delete")
        if token.is_default and token.status == EnrollmentTokenStatus.ACTIVE and not confirm_default:
            raise ValueError("Active default deployment token requires stronger confirmation before delete")
        return self.repo.delete(token)

    def get_active_token(self, token_id: int) -> EnrollmentToken:
        token = self.repo.get(token_id)
        if not token:
            raise ValueError("Enrollment token not found")
        self._refresh_status(token)
        if token.status != EnrollmentTokenStatus.ACTIVE:
            raise ValueError(f"Enrollment token is {token.status.value}")
        return token

    def validate_plaintext_for_token_id(self, token_id: int, plaintext_token: str) -> None:
        token = self.get_active_token(token_id)
        token_hash = self.hash_token(plaintext_token)
        if token.token_hash != token_hash:
            raise ValueError("Enrollment token value does not match selected token")

    def get_active_token_by_plaintext(self, plaintext_token: str) -> EnrollmentToken:
        token_hash = self.hash_token(plaintext_token)
        token = self.repo.get_by_hash(token_hash)
        if not token:
            raise ValueError("invalid")

        self._refresh_status(token)
        if token.status != EnrollmentTokenStatus.ACTIVE:
            raise ValueError(token.status.value)
        return token

    def issue_plaintext_for_token(self, token: EnrollmentToken) -> str:
        self._refresh_status(token)
        if token.status != EnrollmentTokenStatus.ACTIVE:
            raise ValueError(f"Enrollment token is {token.status.value}")

        plaintext_token, token_hash = self._generate_unique_token()
        token.token_hash = token_hash
        token.token_prefix = plaintext_token[:8]
        self.repo.save(token)
        return plaintext_token

    def verify(self, plaintext_token: str) -> EnrollmentTokenVerifyResponse:
        token_hash = self.hash_token(plaintext_token)
        token = self.repo.get_by_hash(token_hash)
        if not token:
            return EnrollmentTokenVerifyResponse(valid=False, status="invalid", message="Enrollment token is invalid")

        self._refresh_status(token)
        if token.status != EnrollmentTokenStatus.ACTIVE:
            return EnrollmentTokenVerifyResponse(
                valid=False,
                status=token.status.value,
                token_id=token.id,
                message=f"Enrollment token is {token.status.value}",
            )

        token.use_count += 1
        if token.use_count >= token.max_uses:
            token.status = EnrollmentTokenStatus.USED
            token.used_at = utcnow()
        token = self.repo.save(token)

        return EnrollmentTokenVerifyResponse(
            valid=True,
            status=token.status.value,
            token_id=token.id,
            client_id=token.client_id,
            group_id=token.group_id,
            message="Enrollment token verified",
        )

    def peek(self, plaintext_token: str) -> EnrollmentTokenVerifyResponse:
        """Check token validity without incrementing use_count."""
        token_hash = self.hash_token(plaintext_token)
        token = self.repo.get_by_hash(token_hash)
        if not token:
            return EnrollmentTokenVerifyResponse(valid=False, status="invalid", message="Enrollment token is invalid")

        self._refresh_status(token)
        if token.status != EnrollmentTokenStatus.ACTIVE:
            return EnrollmentTokenVerifyResponse(
                valid=False,
                status=token.status.value,
                token_id=token.id,
                message=f"Enrollment token is {token.status.value}",
            )

        return EnrollmentTokenVerifyResponse(
            valid=True,
            status=token.status.value,
            token_id=token.id,
            client_id=token.client_id,
            group_id=token.group_id,
            message="Enrollment token is valid",
        )

    def validate_for_enrollment(self, plaintext_token: str) -> EnrollmentToken:
        token_hash = self.hash_token(plaintext_token)
        token = self.repo.get_by_hash(token_hash)
        if not token:
            raise ValueError("invalid")

        self._refresh_status(token)
        if token.status != EnrollmentTokenStatus.ACTIVE:
            raise ValueError(token.status.value)
        return token

    def mark_enrollment_used(self, token: EnrollmentToken) -> EnrollmentToken:
        self._refresh_status(token)
        if token.status != EnrollmentTokenStatus.ACTIVE:
            raise ValueError(token.status.value)

        token.use_count += 1
        if token.use_count >= token.max_uses:
            token.status = EnrollmentTokenStatus.USED
            token.used_at = utcnow()
        return self.repo.save(token)

    def _generate_unique_token(self) -> Tuple[str, str]:
        for _ in range(5):
            plaintext_token = self.generate_plaintext_token()
            token_hash = self.hash_token(plaintext_token)
            if not self.repo.get_by_hash(token_hash):
                return plaintext_token, token_hash
        raise RuntimeError("Unable to generate a unique enrollment token")

    def _refresh_status(self, token: EnrollmentToken) -> EnrollmentToken:
        now = ensure_utc(utcnow())
        expires_at = ensure_utc(token.expires_at)
        if token.status == EnrollmentTokenStatus.ACTIVE and expires_at and expires_at <= now:
            token.status = EnrollmentTokenStatus.EXPIRED
            return self.repo.save(token)
        if token.status == EnrollmentTokenStatus.ACTIVE and token.use_count >= token.max_uses:
            token.status = EnrollmentTokenStatus.USED
            if token.used_at is None:
                token.used_at = now
            return self.repo.save(token)
        return token
