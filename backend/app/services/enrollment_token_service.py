import hashlib
import secrets
from datetime import datetime
from typing import List, Tuple

from sqlalchemy.orm import Session

from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus
from app.repositories.enrollment_token_repository import EnrollmentTokenRepository
from app.schemas.enrollment_token import (
    EnrollmentTokenCreate,
    EnrollmentTokenCreateResponse,
    EnrollmentTokenOut,
    EnrollmentTokenVerifyResponse,
)


class EnrollmentTokenService:
    def __init__(self, db: Session):
        self.repo = EnrollmentTokenRepository(db)

    @staticmethod
    def generate_plaintext_token() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()

    def create(self, payload: EnrollmentTokenCreate) -> EnrollmentTokenCreateResponse:
        plaintext_token, token_hash = self._generate_unique_token()
        token = EnrollmentToken(
            name=payload.name.strip(),
            token_hash=token_hash,
            status=EnrollmentTokenStatus.ACTIVE,
            expires_at=payload.expires_at,
            max_uses=payload.max_uses,
            use_count=0,
            client_id=payload.client_id,
            group_id=payload.group_id,
        )
        created = self.repo.create(token)
        data = EnrollmentTokenOut.model_validate(created).model_dump()
        return EnrollmentTokenCreateResponse(**data, token=plaintext_token)

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
            token.used_at = datetime.utcnow()
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
            token.used_at = datetime.utcnow()
        return self.repo.save(token)

    def _generate_unique_token(self) -> Tuple[str, str]:
        for _ in range(5):
            plaintext_token = self.generate_plaintext_token()
            token_hash = self.hash_token(plaintext_token)
            if not self.repo.get_by_hash(token_hash):
                return plaintext_token, token_hash
        raise RuntimeError("Unable to generate a unique enrollment token")

    def _refresh_status(self, token: EnrollmentToken) -> EnrollmentToken:
        now = datetime.utcnow()
        if token.status == EnrollmentTokenStatus.ACTIVE and token.expires_at and token.expires_at <= now:
            token.status = EnrollmentTokenStatus.EXPIRED
            return self.repo.save(token)
        if token.status == EnrollmentTokenStatus.ACTIVE and token.use_count >= token.max_uses:
            token.status = EnrollmentTokenStatus.USED
            if token.used_at is None:
                token.used_at = now
            return self.repo.save(token)
        return token
