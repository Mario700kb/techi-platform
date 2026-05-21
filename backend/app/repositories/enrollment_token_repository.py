from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.enrollment_token import EnrollmentToken


class EnrollmentTokenRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, token: EnrollmentToken) -> EnrollmentToken:
        self.db.add(token)
        self.db.commit()
        self.db.refresh(token)
        return token

    def get(self, token_id: int) -> Optional[EnrollmentToken]:
        return self.db.query(EnrollmentToken).filter(EnrollmentToken.id == token_id).first()

    def get_by_hash(self, token_hash: str) -> Optional[EnrollmentToken]:
        return self.db.query(EnrollmentToken).filter(EnrollmentToken.token_hash == token_hash).first()

    def list(self, *, limit: int = 100, offset: int = 0) -> List[EnrollmentToken]:
        return (
            self.db.query(EnrollmentToken)
            .filter(EnrollmentToken.is_internal.is_(False))
            .order_by(EnrollmentToken.created_at.desc(), EnrollmentToken.id.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

    def get_active_internal(self, kind: str) -> Optional[EnrollmentToken]:
        from app.models.enrollment_token import EnrollmentTokenStatus
        return (
            self.db.query(EnrollmentToken)
            .filter(
                EnrollmentToken.is_internal.is_(True),
                EnrollmentToken.internal_kind == kind,
                EnrollmentToken.status == EnrollmentTokenStatus.ACTIVE,
            )
            .order_by(EnrollmentToken.id.desc())
            .first()
        )

    def get_active_default(self) -> Optional[EnrollmentToken]:
        from app.models.enrollment_token import EnrollmentTokenStatus
        return (
            self.db.query(EnrollmentToken)
            .filter(EnrollmentToken.is_default.is_(True), EnrollmentToken.status == EnrollmentTokenStatus.ACTIVE)
            .order_by(EnrollmentToken.id.desc())
            .first()
        )

    def get_any_default(self) -> Optional[EnrollmentToken]:
        return (
            self.db.query(EnrollmentToken)
            .filter(EnrollmentToken.is_default.is_(True))
            .order_by(EnrollmentToken.id.desc())
            .first()
        )

    def save(self, token: EnrollmentToken) -> EnrollmentToken:
        self.db.add(token)
        self.db.commit()
        self.db.refresh(token)
        return token

    def delete(self, token: EnrollmentToken) -> EnrollmentToken:
        self.db.delete(token)
        self.db.commit()
        return token
